-- Performance indexes for offer-related tables.
-- Every evaluator request resolves offers by shopId+status then loads
-- conditions and rewards by offerId. Without explicit indexes these
-- queries were doing full sequential scans on every storefront page load.
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offers_shop_status_idx"
  ON "offers" ("shop_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offers_shop_priority_idx"
  ON "offers" ("shop_id", "priority");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offer_conditions_offer_id_idx"
  ON "offer_conditions" ("offer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offer_conditions_shop_id_idx"
  ON "offer_conditions" ("shop_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offer_rewards_offer_id_idx"
  ON "offer_rewards" ("offer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offer_rewards_shop_id_idx"
  ON "offer_rewards" ("shop_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offer_versions_offer_id_idx"
  ON "offer_versions" ("offer_id");
