-- backfill-ok: offers is small (hundreds per shop) and the WHERE only touches rows with a NULL timezone. Stored instants (starts_at/ends_at) are deliberately left untouched.
UPDATE "offers" SET "timezone" = "shops"."timezone" FROM "shops" WHERE "offers"."shop_id" = "shops"."id" AND "offers"."timezone" IS NULL;
