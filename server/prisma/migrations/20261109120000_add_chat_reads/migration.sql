-- Read state per user per conversation, for the Messages inbox and its unread badge.
-- Additive only: a new table, no changes to existing ones.

-- CreateTable
CREATE TABLE "chat_reads" (
    "user_id" UUID NOT NULL,
    "listing_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "last_read_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_reads_pkey" PRIMARY KEY ("user_id","listing_id","buyer_id")
);

-- AddForeignKey
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_reads" ADD CONSTRAINT "chat_reads_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Conversations that existed before this feature start as read for both sides,
-- so nobody's badge lights up with old history the day it ships.
INSERT INTO "chat_reads" ("user_id", "listing_id", "buyer_id", "last_read_at")
SELECT DISTINCT p.user_id, c.listing_id, c.buyer_id, CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT m.listing_id, l.seller_id,
        CASE WHEN m.sender_id = l.seller_id THEN m.recipient_id ELSE m.sender_id END AS buyer_id
    FROM "chat_messages" m
    JOIN "listings" l ON l.id = m.listing_id
) c
CROSS JOIN LATERAL (VALUES (c.seller_id), (c.buyer_id)) AS p(user_id)
ON CONFLICT DO NOTHING;

-- Block Supabase's Data API (see the enable_row_level_security migration).
ALTER TABLE "chat_reads" ENABLE ROW LEVEL SECURITY;
