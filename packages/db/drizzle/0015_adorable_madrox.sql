ALTER TABLE "offers" ADD COLUMN "required_discount_code" text;--> statement-breakpoint
ALTER TABLE "offers" ADD COLUMN "code_discount_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "offers_shop_required_discount_code_idx" ON "offers" USING btree ("shop_id","required_discount_code") WHERE "offers"."required_discount_code" is not null and "offers"."status" != 'archived';