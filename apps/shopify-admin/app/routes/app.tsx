import { Outlet, useLoaderData, useRouteError } from "react-router";
import { AppProvider } from "@shopify/polaris";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import type { LinksFunction } from "react-router";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: polarisStyles }];

// Required for Shopify embedded app auth with React Router v7 single-fetch
export const headers: HeadersFunction = (headersArgs) => {
  return headersArgs.loaderHeaders;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shopDomain: session.shop };
};

function AdminNav() {
  return (
    <NavMenu>
      <a href="/app" rel="home">Dashboard</a>
      <a href="/app/offers">All Offers</a>
      <a href="/app/boosters">Boosters</a>
      <a href="/app/customize">Customize</a>
      <a href="/app/analytics">Analytics</a>
      <a href="/app/translation">Translation</a>
      <a href="/app/settings">Settings</a>
    </NavMenu>
  );
}

export default function AppLayout() {
  useLoaderData<typeof loader>();
  return (
    <AppProvider i18n={{}}>
      <AdminNav />
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <AppProvider i18n={{}}>
      <div style={{ padding: "2rem" }}>
        <h1>Error</h1>
        <pre>{error instanceof Error ? error.message : "Unknown error"}</pre>
      </div>
    </AppProvider>
  );
}
