ALTER TABLE "offers" ADD COLUMN IF NOT EXISTS "tier_mode" text;
--> statement-breakpoint
ALTER TABLE "offer_rewards" ADD COLUMN IF NOT EXISTS "min_cart_subtotal_cents" integer;