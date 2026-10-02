/** Merchant support address; set VITE_SUPPORT_EMAIL. When unset, support mail links are not rendered. */
export function supportMailto(subject?: string): string | null {
  const email = (import.meta.env["VITE_SUPPORT_EMAIL"] as string | undefined)?.trim();
  if (!email) return null;
  return `mailto:${email}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
}
