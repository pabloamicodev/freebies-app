import type { LoaderFunctionArgs } from "react-router";
import { handleProtectedResourceMetadata } from "../lib/mcp/oauth-http.server.js";

export async function loader({ request }: LoaderFunctionArgs) {
  return handleProtectedResourceMetadata(request);
}
