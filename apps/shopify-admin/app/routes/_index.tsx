import { redirect } from "react-router";

/**
 * Root route — always redirects to /app.
 * Shopify Admin opens the embedded app at the application_url (root "/").
 * authenticate.admin() in app.tsx handles OAuth if no session exists.
 * Do NOT call login() here — it creates a redirect loop with auth routes.
 */
export const loader = () => redirect("/app");
