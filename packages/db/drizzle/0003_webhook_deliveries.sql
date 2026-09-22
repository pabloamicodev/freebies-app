-- Idempotency guard for webhook processing: Shopify retries deliveries on any
-- non-2xx response (including the 503s we intentionally return for transient
-- errors), so the same webhook_id can arrive more than once.
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
  "webhook_id" text PRIMARY KEY NOT NULL,
  "topic" text NOT NULL,
  "shop_domain" text NOT NULL,
  "processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
