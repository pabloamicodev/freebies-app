CREATE TYPE "public"."mcp_credential_kind" AS ENUM('pat', 'access', 'refresh');--> statement-breakpoint
CREATE TYPE "public"."mcp_role" AS ENUM('viewer', 'editor', 'admin');--> statement-breakpoint
CREATE TABLE "mcp_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" "mcp_credential_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"family_id" uuid,
	"client_id" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_credentials_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_operators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" "mcp_role" DEFAULT 'viewer' NOT NULL,
	"shop_allow_list" text[] DEFAULT '{}' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_operators_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "mcp_credentials" ADD CONSTRAINT "mcp_credentials_operator_id_mcp_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."mcp_operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_credentials_operator_id_idx" ON "mcp_credentials" USING btree ("operator_id");