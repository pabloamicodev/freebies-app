import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { mcpEnabled } from "../lib/mcp/handler.server.js";
import { notFound, handleAuthorize } from "../lib/mcp/oauth-http.server.js";

// Resource route (no component): the page is raw HTML so CSP/frame headers are fully controlled.
// Checked before getDb() so a deployment without MCP_ENABLED never touches the database.
async function serve(request: Request): Promise<Response> {
  if (!mcpEnabled(process.env)) return notFound();
  return handleAuthorize(request, { db: getDb() });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return serve(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return serve(request);
}
