-- The shop's automatic app discount GID (discountAutomaticAppCreate), created
-- once in afterAuth. The offer-publisher writes the compiled config metafield
-- onto this node instead of the shop, so the Discount Function can read it.
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "discount_id" text;
