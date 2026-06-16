import { isRouteErrorResponse, useRouteError } from "react-router";

export function RouteErrorBoundary() {
  const error = useRouteError();
  const isDev = import.meta.env.DEV;

  let title = "Something went wrong";
  let detail = "An unexpected error occurred. Please refresh or go back.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      title = "Not found";
      detail = "This page doesn't exist.";
    } else if (error.status === 403) {
      title = "Access denied";
      detail = "You don't have permission to view this page.";
    } else {
      title = `Error ${error.status}`;
    }
  }

  const devDetail = isDev && error instanceof Error ? error.message : null;

  return (
    <div className="b-page">
      <div className="b-card b-card-body" style={{ maxWidth: 480, margin: "40px auto", textAlign: "center" }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 8px" }}>{title}</h2>
        <p style={{ fontSize: 14, color: "var(--text-sub)", margin: "0 0 16px" }}>{detail}</p>
        {devDetail && (
          <pre style={{ fontSize: 12, color: "var(--color-critical, #d72c0d)", textAlign: "left", whiteSpace: "pre-wrap", margin: "0 0 16px" }}>
            {devDetail}
          </pre>
        )}
        <a href="/app/offers" className="b-btn b-btn-primary">Go to Offers</a>
      </div>
    </div>
  );
}
