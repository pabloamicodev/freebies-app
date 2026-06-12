import { Outlet, useFetchers, useLoaderData, useNavigation, useRouteError } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import bogosStyles from "../styles/bogos.css?url";
import type { LinksFunction } from "react-router";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: bogosStyles },
];

// Required for Shopify embedded app auth with React Router v7 single-fetch
export const headers: HeadersFunction = (headersArgs) => {
  return headersArgs.loaderHeaders;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return {
    shopDomain: session.shop,
    apiKey: process.env["SHOPIFY_API_KEY"] ?? "",
  };
};

export default function AppLayout() {
  const { apiKey } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const fetchers = useFetchers();
  const [showNavigationIndicator, setShowNavigationIndicator] = useState(false);
  const isNavigating = navigation.state !== "idle";
  const activeFetcherCount = useMemo(
    () => fetchers.filter((fetcher) => fetcher.state !== "idle").length,
    [fetchers],
  );
  const isBusy = isNavigating || activeFetcherCount > 0;
  const loadingLabel = navigation.state === "submitting" || activeFetcherCount > 0
    ? "Saving changes"
    : "Loading page";

  useEffect(() => {
    if (!isBusy) {
      setShowNavigationIndicator(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowNavigationIndicator(true);
    }, 180);

    return () => window.clearTimeout(timer);
  }, [isBusy]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <PolarisAppProvider i18n={{}}>
        {showNavigationIndicator && (
          <div className="b-route-loader" role="status" aria-live="polite" aria-label={loadingLabel}>
            <div className="b-route-loader-track" />
            <div className="b-route-loader-pill">
              <span className="b-route-loader-mark" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>{loadingLabel}</span>
            </div>
          </div>
        )}
        <NavMenu>
          <a href="/app" rel="home">Dashboard</a>
          <a href="/app/offers">All Offers</a>
          <a href="/app/boosters">Boosters</a>
          <a href="/app/customize">Customize</a>
          <a href="/app/analytics">Analytics</a>
          <a href="/app/settings">Settings</a>
          <a href="/app/translation">Translation</a>
          <a href="/app/integrations">Integrations</a>
        </NavMenu>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div style={{ padding: "2rem" }}>
      <h1>Error</h1>
      <pre>{error instanceof Error ? error.message : "Unknown error"}</pre>
    </div>
  );
}
