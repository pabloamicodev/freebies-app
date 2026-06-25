import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, shops } from "@promo/db";

const SIGNATURE_TTL_SECONDS = 10 * 60;

export function verifyAppProxySignature(request: Request): string {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Response("Server misconfigured", { status: 500 });

  const url = new URL(request.url);
  const signature = url.searchParams.get("signature");
  const shop = url.searchParams.get("shop");
  const timestamp = Number(url.searchParams.get("timestamp"));
  if (!signature || !shop || !Number.isFinite(timestamp)) {
    throw new Response("Unauthorized", { status: 401 });
  }

  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_TTL_SECONDS) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const entries = new Map<string, string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    if (key === "signature") continue;
    const values = entries.get(key) ?? [];
    values.push(value);
    entries.set(key, values);
  }

  // Shopify spec: sort by key name (not by "key=value"), join without separator
  const signedMessage = Array.from(entries.entries())
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .join("");
  const calculated = createHmac("sha256", secret).update(signedMessage).digest("hex");

  const signatureBuffer = Buffer.from(signature, "hex");
  const calculatedBuffer = Buffer.from(calculated, "hex");
  if (signatureBuffer.length !== calculatedBuffer.length || !timingSafeEqual(signatureBuffer, calculatedBuffer)) {
    throw new Response("Unauthorized", { status: 401 });
  }

  return shop;
}

export async function getSignedShop(request: Request) {
  const shopDomain = verifyAppProxySignature(request);
  const db = getDb();
  const rows = await db
    .select({ id: shops.id, currencyCode: shops.currencyCode })
    .from(shops)
    .where(and(eq(shops.myshopifyDomain, shopDomain), eq(shops.isActive, true)))
    .limit(1);

  const shop = rows[0];
  if (!shop) throw new Response("Shop not found or app uninstalled", { status: 404 });
  return { ...shop, shopDomain, db };
}
