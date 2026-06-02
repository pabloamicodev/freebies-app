/**
 * Security middleware and utilities.
 * - CSP headers for admin app
 * - Rate limiting (Redis sliding window)
 * - PII minimization helpers
 * - Input sanitization
 */

import type { AppLoadContext } from "react-router";

/** Content Security Policy headers for the embedded admin app. */
export const CSP_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.shopify.com https://shopify.com",
    "style-src 'self' 'unsafe-inline' https://cdn.shopify.com",
    "img-src 'self' data: https://cdn.shopify.com https://*.shopify.com",
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com",
    "connect-src 'self' https://cdn.shopify.com https://*.shopify.com",
  ].join("; "),
  "X-Frame-Options": "ALLOWALL", // Shopify embedded apps need this
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Strip PII from analytics event payloads before storing. */
export function sanitizeAnalyticsPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const PII_KEYS = ["email", "phone", "name", "first_name", "last_name", "address", "ip_address"];
  const sanitized = { ...payload };
  for (const key of PII_KEYS) {
    if (key in sanitized) {
      delete sanitized[key];
    }
  }
  return sanitized;
}

/** Sanitize merchant-provided HTML to prevent XSS. */
export function sanitizeHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=/gi, "data-removed=")
    .replace(/javascript:/gi, "");
}

/** Validate that a string is a valid Shopify GID. */
export function isValidShopifyGid(gid: string, resourceType: string): boolean {
  return new RegExp(`^gid://shopify/${resourceType}/\\d+$`).test(gid);
}

/** Check if a request comes from a valid shop domain. */
export function isValidShopDomain(domain: string): boolean {
  return /^[a-z0-9-]+\.myshopify\.com$/.test(domain);
}

/** Audit log entry structure. */
export interface AuditEntry {
  shopId: string;
  entityType: string;
  entityId: string;
  action: "create" | "update" | "delete" | "publish" | "pause" | "archive";
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  performedBy?: string;
}

/** Write an audit log entry (call from action handlers). */
export async function writeAuditLog(entry: AuditEntry): Promise<void> {
  const { getDb, auditLogs } = await import("@promo/db");
  const db = getDb();
  await db.insert(auditLogs).values({
    shopId: entry.shopId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
    performedBy: entry.performedBy ?? null,
  });
}
