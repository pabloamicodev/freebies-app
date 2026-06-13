import { Links, Meta, Scripts, ScrollRestoration } from "react-router";
import type { ReactNode } from "react";

export function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning prevents React from failing hydration when
    // browser extensions add attributes to html/body that the server didn't render.
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/x-icon" href="/favicon.ico" />
        <Meta />
        <Links />
      </head>
      <body suppressHydrationWarning>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
