CREATE TYPE "public"."discount_code_status" AS ENUM('active', 'disabled', 'exhausted');--> statement-breakpoint
CREATE TABLE "discount_code_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"length" integer NOT NULL,
	"charset" text NOT NULL,
	"count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_code_redemptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"code_id" uuid,
	"code" text NOT NULL,
	"order_id" text NOT NULL,
	"customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discount_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"batch_id" uuid,
	"code" text NOT NULL,
	"requested_code" text,
	"collision_note" text,
	"status" "discount_code_status" DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"usage_limit" integer,
	"once_per_customer" boolean DEFAULT false NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"shopify_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "requires_code" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "discount_code_batches" ADD CONSTRAINT "discount_code_batches_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_batches" ADD CONSTRAINT "discount_code_batches_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_redemptions" ADD CONSTRAINT "discount_code_redemptions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_redemptions" ADD CONSTRAINT "discount_code_redemptions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_code_redemptions" ADD CONSTRAINT "discount_code_redemptions_code_id_discount_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."discount_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_batch_id_discount_code_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."discount_code_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discount_code_batches_offer_idx" ON "discount_code_batches" USING btree ("shop_id","offer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_code_redemptions_order_code_idx" ON "discount_code_redemptions" USING btree ("shop_id","order_id","code");--> statement-breakpoint
CREATE INDEX "discount_code_redemptions_code_idx" ON "discount_code_redemptions" USING btree ("code_id");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_codes_shop_code_idx" ON "discount_codes" USING btree ("shop_id","code");--> statement-breakpoint
CREATE INDEX "discount_codes_offer_idx" ON "discount_codes" USING btree ("shop_id","offer_id","status");--> statement-breakpoint
CREATE INDEX "discount_codes_batch_idx" ON "discount_codes" USING btree ("batch_id");--> statement-breakpoint
-- Offers that already gate on a code keep doing so after the column exists.
UPDATE "offers" SET "requires_code" = true WHERE "required_discount_code" IS NOT NULL;
