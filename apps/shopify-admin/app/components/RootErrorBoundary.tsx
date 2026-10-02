import { Links, Meta, Scripts, isRouteErrorResponse, useRouteError } from "react-router";

export function RootErrorBoundary() {
  const error = useRouteError();

  // Only expose internal error detail in development. In production users see a
  // generic message — leaking error.message can disclose DB internals/stack info.
  const isDev = import.meta.env.DEV;

  let title = "Something went wrong";
  let detail = "An unexpected error occurred. Please try again.";

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    detail = error.status === 404
      ? "The page you're looking for doesn't exist."
      : "An unexpected error occurred. Please try again.";
  }

  const devMessage = error instanceof Error ? error.message : null;

  return (
    <html lang="en">
      <head>
        <title>Error - Promo Engine</title>
        <Meta />
        <Links />
      </head>
      <body>
        <div role="alert" style={{ padding: "2rem", fontFamily: "system-ui", maxWidth: 480, margin: "10vh auto", textAlign: "center" }}>
          <h1 style={{ fontSize: 20 }}>{title}</h1>
          <p style={{ color: "#4b5563" }}>{detail}</p>
          <p style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button type="button" onClick={() => window.location.reload()} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #9ca3af", background: "#fff", cursor: "pointer" }}>
              Try again
            </button>
            <a href="/app" style={{ padding: "8px 14px", borderRadius: 8, background: "#111827", color: "#fff", textDecoration: "none" }}>Open the app</a>
          </p>
          {isDev && devMessage && (
            <pre style={{ color: "red", whiteSpace: "pre-wrap" }}>{devMessage}</pre>
          )}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
