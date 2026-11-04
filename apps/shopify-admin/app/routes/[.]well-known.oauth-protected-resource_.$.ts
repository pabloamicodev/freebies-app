import type { LoaderFunctionArgs } from "react-router";
import { handleProtectedResourceMetadata } from "../lib/mcp/oauth-http.server.js";

// RFC 9728 path-insertion form: /.well-known/oauth-protected-resource/api/mcp
export async function loader({ request }: LoaderFunctionArgs) {
  return handleProtectedResourceMetadata(request);
}
