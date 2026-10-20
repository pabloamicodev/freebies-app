CREATE TABLE "offer_customer_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"customer_gid" text NOT NULL,
	"order_gid" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_usage_sync" (
	"shop_id" uuid NOT NULL,
	"customer_gid" text NOT NULL,
	"pending_since" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "offer_usage_sync_shop_id_customer_gid_pk" PRIMARY KEY("shop_id","customer_gid")
);
--> statement-breakpoint
ALTER TABLE "offer_customer_usages" ADD CONSTRAINT "offer_customer_usages_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_customer_usages" ADD CONSTRAINT "offer_customer_usages_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_usage_sync" ADD CONSTRAINT "offer_usage_sync_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offer_customer_usages_order_offer_idx" ON "offer_customer_usages" USING btree ("shop_id","order_gid","offer_id");--> statement-breakpoint
CREATE INDEX "offer_customer_usages_customer_idx" ON "offer_customer_usages" USING btree ("shop_id","customer_gid","offer_id");--> statement-breakpoint
CREATE INDEX "offer_customer_usages_offer_idx" ON "offer_customer_usages" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "offer_usage_sync_pending_idx" ON "offer_usage_sync" USING btree ("pending_since");
