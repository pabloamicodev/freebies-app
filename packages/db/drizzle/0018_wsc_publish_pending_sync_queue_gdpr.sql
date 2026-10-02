CREATE TABLE "catalog_refresh_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "gdpr_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shops" ADD COLUMN IF NOT EXISTS "publish_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD COLUMN IF NOT EXISTS "shopify_sync_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "catalog_refresh_queue" ADD CONSTRAINT "catalog_refresh_queue_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gdpr_exports" ADD CONSTRAINT "gdpr_exports_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_refresh_queue_item_idx" ON "catalog_refresh_queue" USING btree ("shop_id","kind","ref");--> statement-breakpoint
CREATE INDEX "catalog_refresh_queue_due_idx" ON "catalog_refresh_queue" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "gdpr_exports_shop_customer_idx" ON "gdpr_exports" USING btree ("shop_id","customer_id");--> statement-breakpoint
-- Data backfill: the code gate no longer scans discount_codes, it reads offers.requires_code.
UPDATE "offers" SET "requires_code" = true WHERE "requires_code" = false AND EXISTS (SELECT 1 FROM "discount_codes" c WHERE c."offer_id" = "offers"."id");
