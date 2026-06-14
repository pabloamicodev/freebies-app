import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
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

  const signedMessage = Array.from(entries.entries())
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
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
    .where(eq(shops.myshopifyDomain, shopDomain))
    .limit(1);

  const shop = rows[0];
  if (!shop) throw new Response("Shop not installed", { status: 404 });
  return { ...shop, shopDomain, db };
}
