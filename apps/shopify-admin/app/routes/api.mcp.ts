import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getDb } from "@promo/db";
import { handleMcpRequest, mcpEnabled } from "../lib/mcp/handler.server.js";

// Must be a literal (the Vercel preset parses it statically).
export const config = { maxDuration: 60 };

async function serve(request: Request): Promise<Response> {
  // Checked before getDb() so a deployment without MCP_ENABLED never touches the database.
  if (!mcpEnabled(process.env)) return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return handleMcpRequest(request, { db: getDb() });
}

export async function loader({ request }: LoaderFunctionArgs) {
  return serve(request);
}

export async function action({ request }: ActionFunctionArgs) {
  return serve(request);
}
