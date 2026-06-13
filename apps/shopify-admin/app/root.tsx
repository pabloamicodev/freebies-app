import type { LinksFunction } from "react-router";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700;12..96,800&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap" },
];

export { RootLayout as Layout } from "./components/RootLayout.js";
export { RootApp as default } from "./components/RootApp.js";
export { RootErrorBoundary as ErrorBoundary } from "./components/RootErrorBoundary.js";
