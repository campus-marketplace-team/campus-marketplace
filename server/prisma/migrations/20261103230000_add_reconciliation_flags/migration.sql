-- Reconciliation job (task 3.7): mismatches between an order's ledger and PayPal's records,
-- plus a cursor on orders so each run checks the ones checked longest ago.

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OPEN', 'RESOLVED');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "last_reconciled_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "reconciliation_flags" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "ledger" JSONB NOT NULL,
    "paypal" JSONB NOT NULL,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "reconciliation_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reconciliation_flags_status_last_seen_at_idx" ON "reconciliation_flags"("status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_flags_order_id_kind_key" ON "reconciliation_flags"("order_id", "kind");

-- CreateIndex
CREATE INDEX "orders_last_reconciled_at_idx" ON "orders"("last_reconciled_at");

-- AddForeignKey
ALTER TABLE "reconciliation_flags" ADD CONSTRAINT "reconciliation_flags_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Block Supabase's Data API (see the enable_row_level_security migration).
ALTER TABLE "reconciliation_flags" ENABLE ROW LEVEL SECURITY;
