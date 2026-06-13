import { Links, Meta, Scripts } from "react-router";

export function RootErrorBoundary({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "An unexpected error occurred";
  return (
    <html lang="en">
      <head>
        <title>Error - Promo Engine</title>
        <Meta />
        <Links />
      </head>
      <body>
        <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
          <h1>Application Error</h1>
          <pre style={{ color: "red" }}>{message}</pre>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
