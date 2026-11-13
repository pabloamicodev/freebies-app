/**
 * The "Error Logs" page reads the shop's unresolved Sentry issues. The route loader and the MCP `logs_query`
 * tool share this fetch.
 */
import { safeErrorMessage } from "./safe-error.js";

export interface SentryIssue {
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

export interface ShopLogs {
  issues: SentryIssue[];
  configured: boolean;
  error: string | null;
}

/**
 * Sentry aggregates issues per project across every installed shop; most capture sites tag events with `shop`
 * (webhooks, sync/cron routes), so scoping the query to this shop's tag keeps one merchant from seeing every
 * other merchant's errors. An event that predates shop-tagging just won't surface here.
 */
export async function fetchShopSentryIssues(
  shopDomain: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ShopLogs> {
  const authToken = env["SENTRY_AUTH_TOKEN"];
  const org = env["SENTRY_ORG"];
  const project = env["SENTRY_PROJECT"];

  if (!authToken || !org || !project) {
    return { issues: [], configured: false, error: null };
  }

  try {
    const query = `is:unresolved shop:${shopDomain}`;
    const res = await fetchImpl(
      `https://sentry.io/api/0/projects/${org}/${project}/issues/?query=${encodeURIComponent(query)}&limit=50&sort=date`,
      { headers: { Authorization: `Bearer ${authToken}` }, signal: AbortSignal.timeout(8000) },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { issues: [], configured: true, error: `Sentry API ${res.status}: ${text.slice(0, 200)}` };
    }

    const issues = await res.json() as SentryIssue[];
    return { issues, configured: true, error: null };
  } catch (err) {
    return { issues: [], configured: true, error: safeErrorMessage(err, "Failed to fetch from Sentry") };
  }
}
