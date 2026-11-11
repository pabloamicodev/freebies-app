import { useFetcher } from "react-router";
import { incidentDialogCopy as copy } from "../lib/capacity-workaround-copy.js";
import { describeCapacityModal, isCapacityModalCode } from "../lib/capacity-modal-copy.js";
import type { RecentAction } from "../lib/capacity-workarounds.js";

export interface IncidentRow {
  id: string;
  code: string;
  status: string;
  resolution: string | null;
  occurrences: number;
  source: string;
  lastSeenAt: string;
  offers: string[];
}

interface Props {
  open: IncidentRow[];
  resolved: IncidentRow[];
  actions: RecentAction[];
  now?: number;
}

const titleOf = (row: IncidentRow) =>
  isCapacityModalCode(row.code) ? describeCapacityModal({ code: row.code, offers: row.offers.map((name) => ({ id: name, name })), numbers: {} }).title : row.code;
const when = (iso: string) => new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function Table({ label, rows }: { label: string; rows: IncidentRow[] }) {
  return (
    <table className="b-table" style={{ width: "100%", fontSize: 13 }}>
      <caption style={{ textAlign: "left", fontWeight: 600, padding: "4px 0" }}>{label}</caption>
      <thead>
        <tr>
          <th scope="col" style={{ textAlign: "left" }}>Limit</th>
          <th scope="col" style={{ textAlign: "left" }}>Offers</th>
          <th scope="col" style={{ textAlign: "left" }}>Seen</th>
          <th scope="col" style={{ textAlign: "left" }}>Last</th>
          <th scope="col" style={{ textAlign: "left" }}>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{titleOf(row)}</td>
            <td>{row.offers.join(", ") || "All active offers"}</td>
            <td>{row.occurrences}x via {row.source}</td>
            <td>{when(row.lastSeenAt)}</td>
            <td>{row.resolution ? `Resolved (${row.resolution})` : row.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Diagnostics: open incidents, the last 7 days of resolved ones, and recent fixes with Undo while the window is open. */
export function CapacityIncidentsSection({ open, resolved, actions, now = Date.now() }: Props) {
  const fetcher = useFetcher<{ ok: boolean; message: string }>();
  const empty = open.length === 0 && resolved.length === 0 && actions.length === 0;
  return (
    <section aria-labelledby="capacity-incidents-title" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="capacity-incidents-title" style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>{copy.diagnosticsTitle}</h2>
      {empty && <p style={{ fontSize: 14, margin: 0, color: "var(--text-sub)" }}>{copy.diagnosticsEmpty}</p>}
      {open.length > 0 && <Table label="Open" rows={open} />}
      {resolved.length > 0 && <Table label="Resolved in the last 7 days" rows={resolved} />}
      {actions.length > 0 && (
        <table className="b-table" style={{ width: "100%", fontSize: 13 }}>
          <caption style={{ textAlign: "left", fontWeight: 600, padding: "4px 0" }}>Recent fixes</caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: "left" }}>Fix</th>
              <th scope="col" style={{ textAlign: "left" }}>Status</th>
              <th scope="col" style={{ textAlign: "left" }}>Undo</th>
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => {
              const canUndo = action.status === "applied" && action.undoUntil !== null && new Date(action.undoUntil).getTime() > now;
              return (
                <tr key={action.id}>
                  <td>{action.kind.replaceAll("_", " ")}</td>
                  <td>{action.error ? `${action.status}: ${action.error}` : action.status}</td>
                  <td>
                    {canUndo ? (
                      <button type="button" className="b-btn b-btn-secondary b-btn-sm" onClick={() => fetcher.submit({ intent: "undo", actionId: action.id }, { method: "post", action: "/app/capacity-incidents" })}>
                        {copy.undo}<span className="visually-hidden"> {action.kind.replaceAll("_", " ")}</span>
                      </button>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div role="status" aria-live="polite">{fetcher.data ? <p style={{ fontSize: 13, margin: 0 }}>{fetcher.data.message}</p> : null}</div>
    </section>
  );
}
