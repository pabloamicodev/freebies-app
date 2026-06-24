import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server.js";
import { PageHeader } from "../components/PageHeader.js";
import type { LoaderFunctionArgs } from "react-router";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  level: "error" | "warning" | "info" | "debug" | "fatal";
  count: string;
  userCount: number;
  lastSeen: string;
  firstSeen: string;
  status: "unresolved" | "resolved" | "ignored";
  permalink: string;
  metadata: { type?: string; value?: string };
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const authToken = process.env["SENTRY_AUTH_TOKEN"];
  const org = process.env["SENTRY_ORG"];
  const project = process.env["SENTRY_PROJECT"];

  if (!authToken || !org || !project) {
    return { issues: [] as SentryIssue[], configured: false, error: null as string | null };
  }

  try {
    const res = await fetch(
      `https://sentry.io/api/0/projects/${org}/${project}/issues/?query=is:unresolved&limit=50&sort=date`,
      { headers: { Authorization: `Bearer ${authToken}` }, signal: AbortSignal.timeout(8000) },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { issues: [] as SentryIssue[], configured: true, error: `Sentry API ${res.status}: ${text.slice(0, 200)}` };
    }

    const issues = await res.json() as SentryIssue[];
    return { issues, configured: true, error: null as string | null };
  } catch (err) {
    return { issues: [] as SentryIssue[], configured: true, error: err instanceof Error ? err.message : "Failed to fetch from Sentry" };
  }
};

const LEVEL_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  fatal:   { bg: "#fee2e2", color: "#991b1b", label: "Fatal" },
  error:   { bg: "#fee2e2", color: "#b91c1c", label: "Error" },
  warning: { bg: "#fef3c7", color: "#92400e", label: "Warning" },
  info:    { bg: "#dbeafe", color: "#1e40af", label: "Info" },
  debug:   { bg: "#f3f4f6", color: "#374151", label: "Debug" },
};

export default function LogsPage() {
  const { issues, configured, error } = useLoaderData<typeof loader>();

  const errors   = issues.filter((i) => i.level === "error" || i.level === "fatal");
  const warnings = issues.filter((i) => i.level === "warning");
  const others   = issues.filter((i) => i.level !== "error" && i.level !== "fatal" && i.level !== "warning");

  return (
    <div className="b-page">
      <PageHeader title="Error Logs" backTo="/app" />

      {/* ── summary chips ──────────────────────────────────── */}
      <div className="b-row b-gap-3" style={{ marginBottom: 20 }}>
        <div className="b-card" style={{ flex: 1, padding: "14px 18px" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#b91c1c" }}>{errors.length}</div>
          <div className="b-text-sub b-text-sm">Errors</div>
        </div>
        <div className="b-card" style={{ flex: 1, padding: "14px 18px" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#92400e" }}>{warnings.length}</div>
          <div className="b-text-sub b-text-sm">Warnings</div>
        </div>
        <div className="b-card" style={{ flex: 1, padding: "14px 18px" }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#1e40af" }}>{issues.length}</div>
          <div className="b-text-sub b-text-sm">Total unresolved</div>
        </div>
      </div>

      {/* ── not configured ─────────────────────────────────── */}
      {!configured && (
        <div className="b-banner b-banner-orange" style={{ marginBottom: 16 }}>
          <div className="b-banner-body">
            <p className="b-banner-title">Sentry not configured</p>
            <p className="b-banner-text">
              Add <code>SENTRY_AUTH_TOKEN</code>, <code>SENTRY_ORG</code>, and <code>SENTRY_PROJECT</code> to your
              Vercel environment variables. Generate a token at <strong>sentry.io → Settings → Auth Tokens</strong>.
            </p>
          </div>
        </div>
      )}

      {/* ── API error ──────────────────────────────────────── */}
      {error && (
        <div className="b-banner b-banner-orange" style={{ marginBottom: 16 }}>
          <div className="b-banner-body">
            <p className="b-banner-title">Could not load issues</p>
            <p className="b-banner-text">{error}</p>
          </div>
        </div>
      )}

      {/* ── issues table ───────────────────────────────────── */}
      <div className="b-card" style={{ overflow: "hidden" }}>
        <div className="b-card-header b-row-between">
          <span>Unresolved Issues</span>
          <span className="b-text-sub b-text-sm">live from Sentry · refreshes on load</span>
        </div>

        {issues.length === 0 && configured && !error && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--text-sub)" }}>
            No unresolved issues 🎉
          </div>
        )}

        {issues.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-light)", background: "var(--bg-hover)" }}>
                  <th style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>Level</th>
                  <th style={{ padding: "8px 16px", textAlign: "left", fontWeight: 600 }}>Issue</th>
                  <th style={{ padding: "8px 16px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>Events</th>
                  <th style={{ padding: "8px 16px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>Users</th>
                  <th style={{ padding: "8px 16px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>Last seen</th>
                  <th style={{ padding: "8px 16px", textAlign: "center", fontWeight: 600 }}></th>
                </tr>
              </thead>
              <tbody>
                {issues.map((issue, i) => {
                  const lvl = LEVEL_STYLE[issue.level] ?? LEVEL_STYLE["debug"]!;
                  return (
                    <tr
                      key={issue.id}
                      style={{
                        borderBottom: i < issues.length - 1 ? "1px solid var(--border-light)" : "none",
                        background: issue.level === "fatal" || issue.level === "error" ? "rgba(254,226,226,0.15)" : undefined,
                      }}
                    >
                      <td style={{ padding: "10px 16px", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 4,
                            fontSize: 11,
                            fontWeight: 600,
                            background: lvl.bg,
                            color: lvl.color,
                          }}
                        >
                          {lvl.label}
                        </span>
                      </td>
                      <td style={{ padding: "10px 16px", maxWidth: 420 }}>
                        <div className="b-text-bold b-text-sm" style={{ marginBottom: 2 }}>
                          {issue.title}
                        </div>
                        <div className="b-text-sub" style={{ fontSize: 11 }}>{issue.shortId}</div>
                      </td>
                      <td style={{ padding: "10px 16px", textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" }}>
                        {Number(issue.count).toLocaleString()}
                      </td>
                      <td style={{ padding: "10px 16px", textAlign: "right", whiteSpace: "nowrap" }}>
                        {issue.userCount}
                      </td>
                      <td style={{ padding: "10px 16px", textAlign: "right", whiteSpace: "nowrap" }} className="b-text-sub b-text-sm">
                        {formatRelative(issue.lastSeen)}
                      </td>
                      <td style={{ padding: "10px 16px", textAlign: "center" }}>
                        <a
                          href={issue.permalink}
                          target="_blank"
                          rel="noreferrer"
                          className="b-btn b-btn-sm"
                          style={{ fontSize: 11, whiteSpace: "nowrap" }}
                        >
                          View →
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── resolved / other ───────────────────────────────── */}
      {others.length > 0 && (
        <div className="b-card" style={{ marginTop: 16 }}>
          <div className="b-card-header">Info / Debug ({others.length})</div>
          <div className="b-card-body b-stack b-stack-2">
            {others.map((issue) => {
              const lvl = LEVEL_STYLE[issue.level] ?? LEVEL_STYLE["debug"]!;
              return (
                <div key={issue.id} className="b-row-between" style={{ gap: 12 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                    <span style={{ padding: "2px 6px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: lvl.bg, color: lvl.color, flexShrink: 0 }}>
                      {lvl.label}
                    </span>
                    <span className="b-text-sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {issue.title}
                    </span>
                  </div>
                  <a href={issue.permalink} target="_blank" rel="noreferrer" className="b-btn b-btn-sm" style={{ fontSize: 11, flexShrink: 0 }}>View →</a>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
