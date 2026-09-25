-- Objects declared in src/schema but never emitted as migrations (previously
-- only applied via db:push, if at all). Idempotent so existing databases are safe.
CREATE INDEX IF NOT EXISTS "product_cache_shop_status_idx" ON "product_cache" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "variant_cache_shop_available_idx" ON "variant_cache" USING btree ("shop_id","product_gid","available_for_sale");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_shop_customer_idx" ON "analytics_events" USING btree ("shop_id","customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cart_mutation_logs_shop_idx" ON "cart_mutation_logs" USING btree ("shop_id");--> statement-breakpoint
-- NOT VALID: enforce for new rows without failing on pre-existing orphans.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gift_clone_products_offer_id_offers_id_fk') THEN
    ALTER TABLE "gift_clone_products" ADD CONSTRAINT "gift_clone_products_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
  END IF;
END $$;
