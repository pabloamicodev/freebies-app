import type { LoaderFunctionArgs } from "react-router";
import { handleAuthorizationServerMetadata } from "../lib/mcp/oauth-http.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  return handleAuthorizationServerMetadata(request);
}
