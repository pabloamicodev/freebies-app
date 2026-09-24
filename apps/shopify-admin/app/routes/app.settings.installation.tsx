/**
 * Installation / Theme Blocks page
 * Guides merchant to enable the app embed and place app blocks in the theme editor.
 * Also shows status of extensions (web pixel, checkout extension).
 */

import { useLoaderData } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { detectPromoEngineEmbedStatus } from "../lib/theme-app-embed.server.js";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";
import "../styles/bogos.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shopDomain = session.shop;

  let appEmbedStatus: "enabled" | "disabled" | "unknown" = "unknown";
  let activeThemeId = "";
  let statusDetail = "Shopify did not return a verifiable app embed status.";

  try {
    // Query the active theme's settings_data.json to check if the app embed is enabled
    const res = await admin.graphql(`
      query CheckAppEmbed {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
            name
            files(filenames: ["config/settings_data.json"], first: 1) {
              nodes {
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }
      }
    `);

    interface ThemeFileBody { content?: string }
    interface ThemeFileNode { body?: ThemeFileBody }
    interface ThemeNode {
      id: string;
      name: string;
      files?: { nodes?: ThemeFileNode[] };
    }
    interface ThemeQueryResult {
      data?: { themes?: { nodes?: ThemeNode[] } };
      errors?: Array<{ message?: string }>;
    }

    const data = await res.json() as ThemeQueryResult;
    if (data.errors?.length) {
      throw new Error(data.errors.map((error) => error.message ?? "Theme query failed").join("; "));
    }
    const mainTheme = data.data?.themes?.nodes?.[0];
    activeThemeId = mainTheme?.id ?? "";

    const settingsContent = mainTheme?.files?.nodes?.[0]?.body?.content;
    if (settingsContent) {
      appEmbedStatus = detectPromoEngineEmbedStatus(settingsContent);
      statusDetail = appEmbedStatus === "enabled"
        ? "The published theme settings were read successfully."
        : "The published theme settings confirm that the Promo Engine app embed is not active.";
    } else {
      statusDetail = "The published theme settings file was unavailable.";
    }
  } catch (error) {
    console.warn("[installation] Unable to verify app embed status", {
      shop: shopDomain,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }

  const shopHandle = shopDomain.replace(".myshopify.com", "");
  const themeId = activeThemeId.split("/").pop();
  return {
    shopDomain,
    activeThemeId,
    appEmbedStatus,
    statusDetail,
    themeEditorUrl: themeId
      ? `https://admin.shopify.com/store/${shopHandle}/themes/${themeId}/editor`
      : `https://admin.shopify.com/store/${shopHandle}/themes`,
  };
};

const EXTENSION_STATUS = [
  { label: "Web Pixel Extension (Analytics)", status: "Included in app build" },
  { label: "Checkout UI Extension (Upsell — Plus)", status: "Included in app build" },
  { label: "Customer Account UI Extension", status: "Included in app build" },
  { label: "Discount Function (Rust)", status: "Included in app build" },
  { label: "Cart Transform Function (Rust — Plus)", status: "Included in app build" },
  { label: "Validation Function (Rust)", status: "Included in app build" },
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
  const { themeEditorUrl, appEmbedStatus, statusDetail } = useLoaderData<typeof loader>();
  const appEmbedEnabled = appEmbedStatus === "enabled";

  return (
    <div className="b-page">
      {/* Page header */}
      <PageHeader title="Theme Installation" backTo="/app/settings" />

      {/* Warning banner when embed status is unknown / disabled */}
      {appEmbedStatus !== "enabled" && (
        <div className="b-banner b-banner-orange" style={{ marginBottom: 16 }}>
          <div className="b-banner-icon">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
              <path d="M10 2a8 8 0 100 16A8 8 0 0010 2zm0 4v4m0 4h.01" stroke="#c2410c" strokeWidth="1.6" strokeLinecap="round"/>
            </svg>
          </div>
          <div className="b-banner-body">
            <p className="b-banner-title">
              {appEmbedStatus === "disabled" ? "App embed is disabled" : "App embed status is unknown"}
            </p>
            <p className="b-banner-text">
              {statusDetail} The promo engine requires the app embed to be active in your theme
              editor. Open the theme editor below and enable it under <strong>App embeds</strong>.
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
              {appEmbedEnabled ? "Enabled" : appEmbedStatus === "disabled" ? "Disabled" : "Unknown"}
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
                {appEmbedEnabled
                  ? "Embed active"
                  : appEmbedStatus === "disabled"
                    ? "Embed disabled"
                    : "Status unknown"}
              </span>
            </div>
          </div>
        </div>

        {/* ── Step-by-step guide cards ───────────────────────── */}

        {/* Step 1 */}
        <div className="b-card">
          <div className="b-card-header b-row b-gap-3">
            <span
              className="rd-style-032"
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
              className="rd-style-032"
            >
              2
            </span>
            Add App Blocks{" "}
            <span className="b-badge b-badge-gray" style={{ marginLeft: 4, fontSize: 12 }}>
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
                  <span className="b-badge b-badge-gray" style={{ fontSize: 12 }}>Block</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Step 3 — Extension Status */}
        <div className="b-card">
          <div className="b-card-header b-row b-gap-3">
            <span
              className="rd-style-033"
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
                  <span className="b-badge b-badge-gray">{ext.status}</span>
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
            <p style={{ margin: 0 }}>
              Headless and Hydrogen storefronts aren&apos;t supported yet — Promo Engine currently
              requires an Online Store theme with the app embed enabled.
            </p>
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
                  Theme embeds and app blocks are not applicable. Headless storefront integration
                  is not currently supported by this app.
                </p>
              </div>

              <hr className="b-divider" style={{ margin: "4px 0" }} />

              <div>
                <p className="b-text-bold b-text-sm" style={{ margin: "0 0 4px" }}>
                  Still having issues?
                </p>
                <p className="b-text-sub b-text-sm" style={{ margin: 0 }}>
                  Check the Error Logs page, or contact the development team with the shop domain and
                  a brief description of the issue.
                </p>
              </div>

            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
