-- Seller payout attempts (task 3.5): attempt n uses sender_batch_id payout-<order id>-<n>.
-- Additive only; no new table, so no RLS change.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "payout_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "payout_last_error" TEXT,
ADD COLUMN     "payout_next_attempt_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "orders_state_payout_next_attempt_at_idx" ON "orders"("state", "payout_next_attempt_at");
