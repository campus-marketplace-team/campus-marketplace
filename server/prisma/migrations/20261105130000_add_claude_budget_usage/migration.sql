-- Claude API budget (task 4.9): calls reserved per UTC day, one "total" row and one
-- "user:<id>" row per day. Reservations are atomic conditional upserts on these rows.

-- CreateTable
CREATE TABLE "claude_budget_usage" (
    "day" DATE NOT NULL,
    "scope" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "claude_budget_usage_pkey" PRIMARY KEY ("day","scope")
);

-- Block Supabase's Data API (see the enable_row_level_security migration).
ALTER TABLE "claude_budget_usage" ENABLE ROW LEVEL SECURITY;
