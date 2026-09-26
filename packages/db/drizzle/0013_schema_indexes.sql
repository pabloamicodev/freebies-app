-- FK/retention-cleanup indexes added to the Drizzle schema. Idempotent so a
-- database that already has any of these (e.g. from a manual db:push) is safe.
CREATE INDEX IF NOT EXISTS "widget_placements_widget_id_idx" ON "widget_placements" USING btree ("widget_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widgets_shop_id_idx" ON "widgets" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widgets_offer_id_idx" ON "widgets" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bundle_steps_bundle_id_idx" ON "bundle_steps" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bundle_tiers_bundle_id_idx" ON "bundle_tiers" USING btree ("bundle_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gift_clone_products_offer_id_idx" ON "gift_clone_products" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_events_occurred_at_idx" ON "analytics_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limits_updated_at_idx" ON "rate_limits" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shopify_sessions_shop_idx" ON "shopify_sessions" USING btree ("shop");
