CREATE TABLE "discount_shards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"slot" integer NOT NULL,
	"discount_node_id" text,
	"unit_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_bytes" integer,
	"config_hash" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "discount_shards_shop_kind_slot" UNIQUE("shop_id","kind","slot"),
	CONSTRAINT "discount_shards_kind_check" CHECK ("discount_shards"."kind" in ('cart'))
);
--> statement-breakpoint
ALTER TABLE "discount_shards" ADD CONSTRAINT "discount_shards_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO "discount_shards" ("shop_id", "kind", "slot", "discount_node_id")
SELECT "id", 'cart', 0, "discount_id" FROM "shops" WHERE "discount_id" IS NOT NULL
ON CONFLICT ("shop_id", "kind", "slot") DO NOTHING;
