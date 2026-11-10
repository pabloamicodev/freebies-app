CREATE TABLE "capacity_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"performed_by" text NOT NULL,
	"applied_at" timestamp with time zone,
	"undo_until" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capacity_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"code" text NOT NULL,
	"reason" text,
	"dedupe_key" text NOT NULL,
	"offer_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"numbers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"attended" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"snoozed_until" timestamp with time zone,
	"last_alerted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "capacity_actions" ADD CONSTRAINT "capacity_actions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_actions" ADD CONSTRAINT "capacity_actions_incident_id_capacity_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."capacity_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capacity_incidents" ADD CONSTRAINT "capacity_incidents_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_actions_incident_pending_idx" ON "capacity_actions" USING btree ("incident_id") WHERE "capacity_actions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "capacity_actions_shop_idx" ON "capacity_actions" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_incidents_shop_dedupe_live_idx" ON "capacity_incidents" USING btree ("shop_id","dedupe_key") WHERE "capacity_incidents"."status" in ('open','dismissed');--> statement-breakpoint
CREATE INDEX "capacity_incidents_shop_status_idx" ON "capacity_incidents" USING btree ("shop_id","status");