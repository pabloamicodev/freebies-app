ALTER TABLE "analytics_events" ADD COLUMN IF NOT EXISTS "deduplication_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analytics_events_deduplication_key_idx"
  ON "analytics_events" USING btree ("deduplication_key");
