CREATE TABLE IF NOT EXISTS "catalog_sync_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "shop_id" uuid NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "cursor" text,
  "synced_products" integer DEFAULT 0 NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "sync_started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_until" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "catalog_sync_jobs_shop_id_unique" UNIQUE("shop_id"),
  CONSTRAINT "catalog_sync_jobs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalog_sync_jobs_status_lease_idx" ON "catalog_sync_jobs" USING btree ("status", "lease_until");
