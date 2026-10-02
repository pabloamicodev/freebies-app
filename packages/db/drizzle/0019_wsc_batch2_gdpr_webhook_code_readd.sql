-- backfill-ok: gdpr_exports holds one row per customers/data_request (a handful), so the unique index builds instantly; CONCURRENTLY cannot run inside the migration transaction.
ALTER TABLE "discount_codes" ADD COLUMN "shopify_readd_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD COLUMN "sync_note" text;--> statement-breakpoint
ALTER TABLE "gdpr_exports" ADD COLUMN "webhook_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "gdpr_exports_shop_webhook_idx" ON "gdpr_exports" USING btree ("shop_id","webhook_id");--> statement-breakpoint
CREATE INDEX "gdpr_exports_expires_idx" ON "gdpr_exports" USING btree ("expires_at");