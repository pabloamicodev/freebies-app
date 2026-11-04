ALTER TABLE "mcp_operators" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "mcp_operators" ADD COLUMN "totp_last_step" integer;