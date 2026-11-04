CREATE TABLE "mcp_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid,
	"tool" text NOT NULL,
	"shops" text[] DEFAULT '{}' NOT NULL,
	"args_redacted" jsonb,
	"outcome" text NOT NULL,
	"duration_ms" integer,
	"idempotency_key" text,
	"confirm_jti" text,
	"result_ref" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_call_log_confirm_jti_unique" UNIQUE("confirm_jti")
);
--> statement-breakpoint
ALTER TABLE "mcp_call_log" ADD CONSTRAINT "mcp_call_log_operator_id_mcp_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."mcp_operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_call_log_operator_created_idx" ON "mcp_call_log" USING btree ("operator_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_call_log_created_idx" ON "mcp_call_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_call_log_idempotency_idx" ON "mcp_call_log" USING btree ("operator_id","tool","idempotency_key");