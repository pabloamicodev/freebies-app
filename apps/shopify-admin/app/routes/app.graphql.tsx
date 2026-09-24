import { Form, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { PageHeader } from "../components/PageHeader.js";
import { getShopContext } from "../lib/shop-context.server.js";

export { shopifyHeaders as headers } from "../lib/shopify-headers.js";

const DEFAULT_QUERY = `query StoreOverview {
  shop {
    id
    name
    myshopifyDomain
    currencyCode
  }
}`;

function consoleEnabled(): boolean {
  return process.env["ENABLE_GRAPHQL_CONSOLE"] === "true";
}

export async function loader({ request }: LoaderFunctionArgs) {
  await getShopContext(request);
  return { enabled: consoleEnabled(), defaultQuery: DEFAULT_QUERY };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await getShopContext(request);
  if (!consoleEnabled()) return { ok: false as const, error: "GraphQL console is disabled." };

  const formData = await request.formData();
  const query = String(formData.get("query") ?? "").trim();
  const variablesText = String(formData.get("variables") ?? "{}").trim();
  if (!query) return { ok: false as const, error: "A GraphQL query is required." };
  if (query.length > 50_000) return { ok: false as const, error: "Query is too large." };

  let variables: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(variablesText || "{}");
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
    variables = parsed as Record<string, unknown>;
  } catch {
    return { ok: false as const, error: "Variables must be a valid JSON object.", query, variables: variablesText };
  }

  try {
    const response = await admin.graphql(query, { variables });
    const payload: unknown = await response.json();
    return { ok: response.ok, status: response.status, payload, query, variables: variablesText };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "GraphQL request failed.",
      query,
      variables: variablesText,
    };
  }
}

export default function GraphqlConsolePage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div className="b-page">
      <PageHeader title="GraphQL console" subtitle="Authenticated Shopify Admin API workspace for diagnostics and controlled operations." />

      {!data.enabled ? (
        <div className="b-banner b-banner-orange" role="alert">
          This internal tool is disabled. Set <code>ENABLE_GRAPHQL_CONSOLE=true</code> to make it available to authenticated app admins.
        </div>
      ) : (
        <div className="b-grid-2 b-items-start">
          <section className="b-card b-p-5">
            <Form method="post" className="b-stack b-stack-4">
              <div>
                <label className="b-label" htmlFor="graphqlQuery">Query or mutation</label>
                <textarea id="graphqlQuery" className="b-textarea b-text-mono" name="query" rows={18} spellCheck={false} defaultValue={actionData && "query" in actionData ? actionData.query : data.defaultQuery} />
              </div>
              <div>
                <label className="b-label" htmlFor="graphqlVariables">Variables (JSON)</label>
                <textarea id="graphqlVariables" className="b-textarea b-text-mono" name="variables" rows={7} spellCheck={false} defaultValue={actionData && "variables" in actionData ? actionData.variables : "{}"} />
              </div>
              <button className="b-btn b-btn-primary b-self-start" type="submit">Run GraphQL</button>
            </Form>
          </section>

          <section className="b-card b-p-5">
            <div className="b-row b-justify-between b-mb-4">
              <h2 className="b-editor-section-title">Response</h2>
              {actionData && "status" in actionData && <span className={`b-badge ${actionData.ok ? "b-badge-green" : "b-badge-orange"}`}>HTTP {actionData.status}</span>}
            </div>
            {actionData ? (
              <pre className="b-code-output">{JSON.stringify("payload" in actionData ? actionData.payload : { error: actionData.error }, null, 2)}</pre>
            ) : (
              <p className="b-text-sm b-text-muted">Run a query to inspect the raw Shopify response.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
