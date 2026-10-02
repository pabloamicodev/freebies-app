import { useFetcher } from "react-router";

type RestoreResponse = { ok: true; restored: number; failed: number } | { ok: false; error: string };

/** Shown on the dashboard after a reinstall while offers archived by the uninstall are still archived. */
export function RestoreOffersBanner({ count }: { count: number }) {
  const fetcher = useFetcher<RestoreResponse>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  if (data?.ok) {
    return (
      <div className="b-banner b-banner-green b-mb-4" role="status">
        <div className="b-banner-body">
          <div className="b-banner-title">
            {data.restored} offer{data.restored === 1 ? "" : "s"} restored
          </div>
          {data.failed > 0 && (
            <p className="b-banner-text">
              {data.failed} could not be restored automatically. Open All Offers and check the archived list.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (count <= 0) return null;

  return (
    <div className="b-banner b-banner-orange b-mb-4" role="status">
      <div className="b-banner-body">
        <div className="b-banner-title">Welcome back</div>
        <p className="b-banner-text">
          {count} offer{count === 1 ? " was" : "s were"} archived when the app was uninstalled. Restore them to put
          them back where they were.
        </p>
        {data && !data.ok && (
          <p className="b-banner-text" role="alert">{data.error}</p>
        )}
      </div>
      <fetcher.Form method="POST" action="/app/restore-offers">
        <button type="submit" className="b-btn b-btn-secondary b-btn-sm" disabled={busy}>
          {busy ? "Restoring…" : "Restore offers"}
        </button>
      </fetcher.Form>
    </div>
  );
}
