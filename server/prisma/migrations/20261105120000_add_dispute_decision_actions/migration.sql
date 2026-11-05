-- Dispute agent action tools + approval gate (task 4.7): where each dispute decision is,
-- and how much of an order a decision gave back to the buyer. Additive, so code deployed
-- before this migration keeps working.

-- CreateEnum
CREATE TYPE "DecisionActionStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'EXECUTED', 'REJECTED', 'FAILED');

-- AlterTable
ALTER TABLE "decisions" ADD COLUMN     "action_error" TEXT,
ADD COLUMN     "action_status" "DecisionActionStatus",
ADD COLUMN     "executed_at" TIMESTAMPTZ(3),
ADD COLUMN     "rejected_at" TIMESTAMPTZ(3),
ADD COLUMN     "review_note" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "refunded_cents" INTEGER NOT NULL DEFAULT 0;

-- Refunds are capped at the amount paid, whatever the code above this does.
ALTER TABLE "orders" ADD CONSTRAINT "orders_refunded_cents_within_amount" CHECK ("refunded_cents" >= 0 AND "refunded_cents" <= "amount_cents");

-- CreateIndex
CREATE INDEX "decisions_action_status_approved_at_idx" ON "decisions"("action_status", "approved_at");
