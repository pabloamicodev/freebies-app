-- Existing rows were already acknowledged and therefore remain processed.
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'processed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "last_error" text;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "status" SET DEFAULT 'processing';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_status_attempt_idx" ON "webhook_deliveries" USING btree ("status", "last_attempt_at");
