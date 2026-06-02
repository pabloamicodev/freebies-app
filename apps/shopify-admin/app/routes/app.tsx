import { Outlet, useLoaderData, useNavigate, useRouteError } from "react-router";
import { AppProvider, Frame, Navigation } from "@shopify/polaris";
import {
  HomeIcon, OrderIcon, ChartVerticalFilledIcon, SettingsIcon,
  ColorIcon, ThumbsUpIcon, CodeIcon, GlobeIcon,
} from "@shopify/polaris-icons";
import { authenticate } from "../shopify.server.js";
import type { LoaderFunctionArgs } from "react-router";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import type { LinksFunction } from "react-router";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shopDomain: session.shop };
};

function AdminNav() {
  const navigate = useNavigate();
  return (
    <Navigation location="/">
      <Navigation.Section
        items={[
          { label: "Dashboard", icon: HomeIcon, url: "/app", onClick: () => navigate("/app") },
          {
            label: "All Offers",
            icon: OrderIcon,
            url: "/app/offers",
            onClick: () => navigate("/app/offers"),
            subNavigationItems: [
              { label: "🎁 Gift Offers", url: "/app/offers?type=gift" },
              { label: "📦 Bundle Offers", url: "/app/offers?type=bundle" },
              { label: "⬆️ Upsell Offers", url: "/app/offers?type=upsell" },
              { label: "💰 Discount Offers", url: "/app/offers?type=discount" },
            ],
          },
          {
            label: "Boosters",
            icon: ThumbsUpIcon,
            url: "/app/boosters",
            onClick: () => navigate("/app/boosters"),
          },
          {
            label: "Customize",
            icon: ColorIcon,
            url: "/app/customize",
            onClick: () => navigate("/app/customize"),
          },
          {
            label: "Analytics",
            icon: ChartVerticalFilledIcon,
            url: "/app/analytics",
            onClick: () => navigate("/app/analytics"),
          },
          {
            label: "Translation",
            icon: GlobeIcon,
            url: "/app/translation",
            onClick: () => navigate("/app/translation"),
          },
          {
            label: "Settings",
            icon: SettingsIcon,
            url: "/app/settings",
            onClick: () => navigate("/app/settings"),
            subNavigationItems: [
              { label: "Installation", url: "/app/settings/installation" },
              { label: "Inventory Policy", url: "/app/settings/inventory" },
              { label: "POS Settings", url: "/app/settings/pos" },
              { label: "Migration", url: "/app/migration" },
              { label: "Diagnostics", url: "/app/diagnostics" },
              { label: "AI Assistant", url: "/app/ai" },
            ],
          },
        ]}
      />
    </Navigation>
  );
}

export default function AppLayout() {
  const { shopDomain } = useLoaderData<typeof loader>();
  return (
    <AppProvider i18n={{}}>
      <Frame navigation={<AdminNav />} logo={{ width: 124, contextualSaveBarSource: "/logo.svg" }}>
        <Outlet />
      </Frame>
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
