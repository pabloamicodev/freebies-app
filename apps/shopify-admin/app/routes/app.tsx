import { Outlet, isRouteErrorResponse, useFetchers, useLoaderData, useLocation, useNavigation, useRouteError } from "react-router";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server.js";
import { createRouteTimer } from "../lib/route-timing.server.js";
import { shopifyHeaders } from "../lib/shopify-headers.js";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import bogosStyles from "../styles/bogos.css?url";
import type { LinksFunction } from "react-router";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: bogosStyles },
];

// Required for Shopify embedded app auth with React Router v7 single-fetch
export const headers: HeadersFunction = shopifyHeaders;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const timer = createRouteTimer("app");
  const { session } = await timer.time("authenticate_admin", () => authenticate.admin(request));
  timer.done({ shopDomain: session.shop });

  return {
    shopDomain: session.shop,
    apiKey: process.env["SHOPIFY_API_KEY"] ?? "",
    graphqlConsoleEnabled: process.env["ENABLE_GRAPHQL_CONSOLE"] === "true",
  };
};

export default function AppLayout() {
  const { apiKey, graphqlConsoleEnabled } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const location = useLocation();
  const fetchers = useFetchers();
  const [showNavigationIndicator, setShowNavigationIndicator] = useState(false);
  const [documentNavigationPending, setDocumentNavigationPending] = useState(false);
  const isNavigating = navigation.state !== "idle";
  const activeFetcherCount = fetchers.reduce((count, fetcher) => count + (fetcher.state !== "idle" ? 1 : 0), 0);
  const isBusy = isNavigating || activeFetcherCount > 0 || documentNavigationPending;
  const loadingLabel = navigation.state === "submitting" || activeFetcherCount > 0
    ? "Saving changes"
    : "Loading page";

  useEffect(() => {
    setDocumentNavigationPending(false);
  }, [location.key]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement)) return;
      if (target.target && target.target !== "_self") return;
      if (target.hasAttribute("download")) return;
      const nextUrl = new URL(target.href, window.location.href);
      if (nextUrl.origin !== window.location.origin) return;
      if (!nextUrl.pathname.startsWith("/app")) return;
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      const next = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
      if (next !== current) flushSync(() => setDocumentNavigationPending(true));
    };

    const handleSubmit = (event: SubmitEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof HTMLFormElement)) return;
      const action = new URL(target.action || window.location.href, window.location.href);
      if (action.origin === window.location.origin && action.pathname.startsWith("/app")) {
        flushSync(() => setDocumentNavigationPending(true));
      }
    };

    document.addEventListener("click", handleClick, true);
    document.addEventListener("submit", handleSubmit, true);
    return () => {
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("submit", handleSubmit, true);
    };
  }, []);

  useEffect(() => {
    if (!isBusy) {
      setShowNavigationIndicator(false);
      return;
    }

    const timer = window.setTimeout(() => {
      setShowNavigationIndicator(true);
    }, 80);

    return () => window.clearTimeout(timer);
  }, [isBusy]);

  return (
    <AppProvider apiKey={apiKey}>
      <PolarisAppProvider i18n={{}}>
        {showNavigationIndicator && (
          <output className="b-route-loader" aria-live="polite" aria-label={loadingLabel}>
            <div className="b-route-loader-track" />
            <div className="b-route-loader-pill">
              <span className="b-route-loader-mark" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              <span>{loadingLabel}</span>
            </div>
          </output>
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
          {graphqlConsoleEnabled && <a href="/app/graphql">GraphQL</a>}
          <a href="/app/logs">Error Logs</a>
        </NavMenu>
        <Outlet />
      </PolarisAppProvider>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isDev = import.meta.env.DEV;

  // Shopify's auth helpers throw 2xx/3xx responses (App Bridge bounce page, exit-iframe) and 401 reauth
  // whose HTML must run; real 4xx failures are rendered as escaped text.
  const isShopifyAuthResponse = isRouteErrorResponse(error) && (error.status < 400 || error.status === 401);
  const isClientError = isRouteErrorResponse(error) && error.status >= 400 && error.status < 500 && !isShopifyAuthResponse;

  useEffect(() => {
    if (isClientError || isShopifyAuthResponse) return;
    const message = error instanceof Error
      ? error.message
      : isRouteErrorResponse(error)
        ? `${error.status} ${error.statusText}: ${typeof error.data === "string" ? error.data : JSON.stringify(error.data)}`
        : JSON.stringify(error);
    const stack = error instanceof Error ? (error.stack ?? "") : "";
    fetch("/api/report-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, stack, url: window.location.href }),
    }).catch(() => undefined);
  }, [error, isClientError]);

  if (isShopifyAuthResponse) return boundary.error(error);
  if (isClientError) {
    return (
      <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
        <h1>{error.status === 404 ? "Not found" : "Request failed"}</h1>
        <p>{typeof error.data === "string" && error.data.length < 300 ? error.data : error.statusText}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
      <h1>Something went wrong</h1>
      <p>An unexpected error occurred. Please try again.</p>
      {isDev && error instanceof Error && (
        <pre style={{ color: "red", whiteSpace: "pre-wrap" }}>{error.message}</pre>
      )}
    </div>
  );
}
