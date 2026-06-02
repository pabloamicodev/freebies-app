CREATE TYPE "public"."condition_operator" AS ENUM('eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'contains', 'not_contains', 'all', 'any');--> statement-breakpoint
CREATE TYPE "public"."condition_scope" AS ENUM('main', 'sub', 'quantity_limit', 'visibility');--> statement-breakpoint
CREATE TYPE "public"."discount_type" AS ENUM('percentage', 'fixed_amount', 'fixed_price', 'free', 'cheapest_item_free', 'most_expensive_item_discount');--> statement-breakpoint
CREATE TYPE "public"."offer_status" AS ENUM('draft', 'active', 'paused', 'scheduled', 'expired', 'archived');--> statement-breakpoint
CREATE TYPE "public"."offer_type" AS ENUM('gift', 'bundle', 'upsell', 'discount', 'booster');--> statement-breakpoint
CREATE TYPE "public"."reward_type" AS ENUM('product_gift', 'shipping_discount', 'product_discount', 'order_discount', 'bundle_discount', 'upsell_discount');--> statement-breakpoint
CREATE TYPE "public"."widget_type" AS ENUM('gift_slider', 'gift_popup', 'cart_message', 'today_offer_widget', 'today_offer_block', 'progress_bar', 'gift_icon', 'gift_thumbnail', 'classic_bundle', 'mix_match_bundle', 'bundle_page', 'checkout_upsell', 'fbt', 'thank_you_upsell', 'volume_discount');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_shop_key" UNIQUE("shop_id","key")
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_domain" text NOT NULL,
	"myshopify_domain" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"storefront_public_token" text,
	"plan_name" text,
	"currency_code" text NOT NULL,
	"timezone" text NOT NULL,
	"locale" text,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shops_shop_domain_unique" UNIQUE("shop_domain"),
	CONSTRAINT "shops_myshopify_domain_unique" UNIQUE("myshopify_domain")
);
--> statement-breakpoint
CREATE TABLE "offer_combination_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"combines_with_order_discounts" boolean DEFAULT true NOT NULL,
	"combines_with_product_discounts" boolean DEFAULT true NOT NULL,
	"combines_with_shipping_discounts" boolean DEFAULT true NOT NULL,
	"combines_with_other_app_offers" boolean DEFAULT true NOT NULL,
	"stop_lower_priority" boolean DEFAULT false NOT NULL,
	"gift_value_counts_for_other_offers" boolean DEFAULT false NOT NULL,
	"max_applications_per_cart" integer,
	"max_applications_per_customer" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_combination_policies_offer_id" UNIQUE("offer_id")
);
--> statement-breakpoint
CREATE TABLE "offer_conditions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"scope" "condition_scope" NOT NULL,
	"condition_type" text NOT NULL,
	"operator" "condition_operator" NOT NULL,
	"value" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"reward_type" "reward_type" NOT NULL,
	"discount_type" "discount_type" NOT NULL,
	"value" jsonb NOT NULL,
	"target" jsonb NOT NULL,
	"quantity" integer,
	"is_auto_add" boolean DEFAULT false NOT NULL,
	"is_customer_selectable" boolean DEFAULT false NOT NULL,
	"track_mode" text DEFAULT 'product' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offer_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_versions_offer_version" UNIQUE("offer_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"type" "offer_type" NOT NULL,
	"status" "offer_status" DEFAULT 'draft' NOT NULL,
	"internal_name" text NOT NULL,
	"public_title" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"timezone" text,
	"compiled_config" jsonb,
	"function_metafield_gid" text,
	"discount_tags" text[] DEFAULT '{}' NOT NULL,
	"created_by" text,
	"updated_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offers_shop_internal_name" UNIQUE("shop_id","internal_name")
);
--> statement-breakpoint
CREATE TABLE "widget_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"widget_id" uuid NOT NULL,
	"placement_type" text NOT NULL,
	"selector" text,
	"page_rule" jsonb,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid,
	"type" "widget_type" NOT NULL,
	"internal_name" text NOT NULL,
	"title" text,
	"subtitle" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bundle_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"bundle_type" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"page_heading" text,
	"page_subheading" text,
	"banner_image_url" text,
	"layout_mode" text DEFAULT 'all_steps_one_page' NOT NULL,
	"create_bundle_product" boolean DEFAULT false NOT NULL,
	"bundle_product_gid" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bundle_definitions_offer_id" UNIQUE("offer_id")
);
--> statement-breakpoint
CREATE TABLE "bundle_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"bundle_id" uuid NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"source_type" text NOT NULL,
	"source_config" jsonb NOT NULL,
	"min_quantity" integer,
	"max_quantity" integer,
	"search_enabled" boolean DEFAULT false NOT NULL,
	"sort_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filter_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bundle_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"bundle_id" uuid NOT NULL,
	"min_quantity" integer NOT NULL,
	"label" text NOT NULL,
	"discount_type" "discount_type" NOT NULL,
	"value" jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_clone_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"reward_id" uuid NOT NULL,
	"source_product_gid" text NOT NULL,
	"source_variant_gid" text NOT NULL,
	"clone_product_gid" text NOT NULL,
	"clone_variant_gid" text NOT NULL,
	"clone_handle" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"product_gid" text NOT NULL,
	"legacy_product_id" bigint,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"vendor" text,
	"product_type" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"status" text,
	"published_scope" jsonb,
	"markets" jsonb,
	"collections" text[] DEFAULT '{}' NOT NULL,
	"image_url" text,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_cache_shop_gid" UNIQUE("shop_id","product_gid")
);
--> statement-breakpoint
CREATE TABLE "variant_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"product_gid" text NOT NULL,
	"variant_gid" text NOT NULL,
	"legacy_variant_id" bigint,
	"sku" text,
	"title" text NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"compare_at_price" numeric(18, 4),
	"currency_code" text NOT NULL,
	"inventory_quantity" bigint,
	"inventory_policy" text,
	"available_for_sale" boolean DEFAULT true NOT NULL,
	"requires_selling_plan" boolean DEFAULT false NOT NULL,
	"raw" jsonb NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_cache_shop_gid" UNIQUE("shop_id","variant_gid")
);
--> statement-breakpoint
CREATE TABLE "analytics_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"event_name" text NOT NULL,
	"session_id" text,
	"cart_token" text,
	"customer_id" text,
	"offer_id" uuid,
	"offer_version" text,
	"widget_id" uuid,
	"order_id" text,
	"ab_variant" text,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"performed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cart_mutation_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"session_id" text,
	"cart_token" text,
	"mutation_type" text NOT NULL,
	"offer_id" uuid,
	"source" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"status" text NOT NULL,
	"error_message" text,
	"duration_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_combination_policies" ADD CONSTRAINT "offer_combination_policies_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_combination_policies" ADD CONSTRAINT "offer_combination_policies_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_conditions" ADD CONSTRAINT "offer_conditions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_conditions" ADD CONSTRAINT "offer_conditions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_rewards" ADD CONSTRAINT "offer_rewards_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_rewards" ADD CONSTRAINT "offer_rewards_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_versions" ADD CONSTRAINT "offer_versions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_placements" ADD CONSTRAINT "widget_placements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_placements" ADD CONSTRAINT "widget_placements_widget_id_widgets_id_fk" FOREIGN KEY ("widget_id") REFERENCES "public"."widgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widgets" ADD CONSTRAINT "widgets_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_definitions" ADD CONSTRAINT "bundle_definitions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_definitions" ADD CONSTRAINT "bundle_definitions_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_steps" ADD CONSTRAINT "bundle_steps_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_steps" ADD CONSTRAINT "bundle_steps_bundle_id_bundle_definitions_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundle_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_tiers" ADD CONSTRAINT "bundle_tiers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_tiers" ADD CONSTRAINT "bundle_tiers_bundle_id_bundle_definitions_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundle_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_clone_products" ADD CONSTRAINT "gift_clone_products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_cache" ADD CONSTRAINT "product_cache_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_cache" ADD CONSTRAINT "variant_cache_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_mutation_logs" ADD CONSTRAINT "cart_mutation_logs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_cache_shop_handle_idx" ON "product_cache" USING btree ("shop_id","handle");--> statement-breakpoint
CREATE INDEX "product_cache_shop_tags_idx" ON "product_cache" USING btree ("shop_id","tags");--> statement-breakpoint
CREATE INDEX "variant_cache_shop_product_idx" ON "variant_cache" USING btree ("shop_id","product_gid");--> statement-breakpoint
CREATE INDEX "variant_cache_shop_sku_idx" ON "variant_cache" USING btree ("shop_id","sku");--> statement-breakpoint
CREATE INDEX "analytics_events_shop_offer_time_idx" ON "analytics_events" USING btree ("shop_id","offer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_shop_session_idx" ON "analytics_events" USING btree ("shop_id","session_id");--> statement-breakpoint
CREATE INDEX "analytics_events_shop_event_idx" ON "analytics_events" USING btree ("shop_id","event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_events_order_idx" ON "analytics_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("shop_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "cart_mutation_logs_shop_time_idx" ON "cart_mutation_logs" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "cart_mutation_logs_status_idx" ON "cart_mutation_logs" USING btree ("shop_id","status","created_at");