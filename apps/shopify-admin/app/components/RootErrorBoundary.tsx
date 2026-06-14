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
        <div style={{ padding: "2rem", fontFamily: "system-ui" }}>
          <h1>{title}</h1>
          <p>{detail}</p>
          {isDev && devMessage && (
            <pre style={{ color: "red", whiteSpace: "pre-wrap" }}>{devMessage}</pre>
          )}
        </div>
        <Scripts />
      </body>
    </html>
  );
}
