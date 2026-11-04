-- When the current authorization's 3-day honor period ends (task 3.6). Set at
-- checkout and moved forward by each reauthorization. Additive only; no new
-- table, so no RLS change.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "honor_period_ends_at" TIMESTAMPTZ(3);

-- Backfill: existing authorizations were never reauthorized.
UPDATE "orders" SET "honor_period_ends_at" = "authorized_at" + INTERVAL '3 days' WHERE "authorized_at" IS NOT NULL;

-- CreateIndex
CREATE INDEX "orders_state_honor_period_ends_at_idx" ON "orders"("state", "honor_period_ends_at");
