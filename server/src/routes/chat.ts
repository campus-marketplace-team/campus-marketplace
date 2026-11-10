import { Router, type Request, type Response } from "express";
import { CHAT_LIMITS } from "@campus/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { isUuid } from "../ids.js";

// Buyer <-> seller chat, one thread per (listing, buyer). The seller is always
// the listing's seller, so a thread is identified by listingId + buyerId.
//
// Message bodies are untrusted input (prompt injection, scams). They're stored
// and returned as plain text and must never unlock money (see CLAUDE.md).

export const chatRouter = Router();
chatRouter.use(requireAuth);

const publicMessage = {
  id: true,
  listingId: true,
  senderId: true,
  recipientId: true,
  body: true,
  createdAt: true,
} as const;

type Thread = { listingId: string; sellerId: string; buyerId: string };

// Works out which thread the logged-in user means, or sends an error and returns null.
// - A buyer always means their own thread with the seller (buyerId may be omitted).
// - The seller must say which buyer, with buyerId.
// Anyone else asking for someone else's thread gets 403.
async function resolveThread(req: Request, res: Response, buyerParam: unknown): Promise<Thread | null> {
  const listingId = req.params.listingId;
  const listing = isUuid(listingId)
    ? await prisma.listing.findUnique({ where: { id: listingId }, select: { id: true, sellerId: true, status: true } })
    : null;
  if (!listing || listing.status === "REMOVED") {
    res.status(404).json({ error: "Listing not found" });
    return null;
  }

  const me = req.user!.id;
  if (me === listing.sellerId) {
    if (!isUuid(buyerParam) || buyerParam === me) {
      res.status(400).json({ error: "As the seller, pass buyerId to pick a conversation" });
      return null;
    }
    return { listingId: listing.id, sellerId: me, buyerId: buyerParam };
  }

  if (buyerParam !== undefined && buyerParam !== "" && buyerParam !== me) {
    res.status(403).json({ error: "You can only read your own conversations" });
    return null;
  }
  return { listingId: listing.id, sellerId: listing.sellerId, buyerId: me };
}

function threadWhere(t: Thread) {
  return {
    listingId: t.listingId,
    OR: [
      { senderId: t.buyerId, recipientId: t.sellerId },
      { senderId: t.sellerId, recipientId: t.buyerId },
    ],
  };
}

const conversationKey = (listingId: string, buyerId: string) => `${listingId}:${buyerId}`;

/**
 * My unread conversations: the other person has a message newer than my read
 * marker, or I have no marker yet. Only messages sent to me count, so it can
 * never include anyone else's conversation, and my own messages never make a
 * conversation unread.
 */
export async function findUnreadConversations(me: string) {
  return prisma.$queryRaw<{ listing_id: string; buyer_id: string }[]>`
    SELECT t.listing_id, t.buyer_id
    FROM (
      SELECT m.listing_id,
        CASE WHEN m.sender_id = l.seller_id THEN m.recipient_id ELSE m.sender_id END AS buyer_id,
        max(m.created_at) AS last_incoming_at
      FROM chat_messages m
      JOIN listings l ON l.id = m.listing_id
      WHERE m.recipient_id = ${me}::uuid AND l.status <> 'REMOVED'
      GROUP BY 1, 2
    ) t
    LEFT JOIN chat_reads r
      ON r.user_id = ${me}::uuid AND r.listing_id = t.listing_id AND r.buyer_id = t.buyer_id
    WHERE r.last_read_at IS NULL OR t.last_incoming_at > r.last_read_at`;
}

// GET /api/chats/unread-count — how many of my conversations are unread. Polled by
// the nav badge, so it's one query and has its own rate limit bucket (see rateLimit.ts).
chatRouter.get("/unread-count", async (req, res) => {
  const unread = await findUnreadConversations(req.user!.id);
  res.json({ unreadCount: unread.length });
});

// GET /api/chats — my conversations, most recent first, each with its last message.
chatRouter.get("/", async (req, res) => {
  const me = req.user!.id;
  const latest = await prisma.$queryRaw<
    { listing_id: string; seller_id: string; buyer_id: string; message_id: string }[]
  >`
    SELECT DISTINCT ON (m.listing_id, buyer_id)
      m.listing_id, l.seller_id, buyer_id, m.id AS message_id
    FROM chat_messages m
    JOIN listings l ON l.id = m.listing_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN m.sender_id = l.seller_id THEN m.recipient_id ELSE m.sender_id END AS buyer_id
    ) b
    WHERE (m.sender_id = ${me}::uuid OR m.recipient_id = ${me}::uuid)
      AND l.status <> 'REMOVED'
    ORDER BY m.listing_id, buyer_id, m.created_at DESC, m.id DESC`;

  const [messages, listings, users, unread] = await Promise.all([
    prisma.chatMessage.findMany({ where: { id: { in: latest.map((t) => t.message_id) } }, select: publicMessage }),
    prisma.listing.findMany({
      where: { id: { in: latest.map((t) => t.listing_id) } },
      select: { id: true, title: true, status: true, priceCents: true, photoUrls: true },
    }),
    prisma.user.findMany({
      where: { id: { in: latest.flatMap((t) => [t.seller_id, t.buyer_id]) } },
      select: { id: true, displayName: true },
    }),
    findUnreadConversations(me),
  ]);
  const unreadKeys = new Set(unread.map((u) => conversationKey(u.listing_id, u.buyer_id)));
  const messageById = new Map(messages.map((m) => [m.id, m]));
  const listingById = new Map(listings.map((l) => [l.id, l]));
  const userById = new Map(users.map((u) => [u.id, u]));

  const threads = latest
    .map((t) => {
      const otherId = t.seller_id === me ? t.buyer_id : t.seller_id;
      return {
        listing: listingById.get(t.listing_id)!,
        buyerId: t.buyer_id,
        role: t.seller_id === me ? ("seller" as const) : ("buyer" as const),
        otherUser: userById.get(otherId) ?? { id: otherId, displayName: "Unknown" },
        lastMessage: messageById.get(t.message_id)!,
        unread: unreadKeys.has(conversationKey(t.listing_id, t.buyer_id)),
      };
    })
    .sort((a, b) => b.lastMessage.createdAt.getTime() - a.lastMessage.createdAt.getTime());

  res.json({ threads });
});

// GET /api/chats/:listingId/messages?buyerId=...&after=<messageId>
// Oldest first. Without `after`: the latest 100 messages. With `after`: up to 100
// messages newer than that one, so a client can poll with the last id it has.
chatRouter.get("/:listingId/messages", async (req, res) => {
  const thread = await resolveThread(req, res, req.query.buyerId);
  if (!thread) return;
  const where = threadWhere(thread);

  const after = req.query.after;
  if (after !== undefined) {
    const cursor = isUuid(after)
      ? await prisma.chatMessage.findFirst({ where: { ...where, id: after }, select: { id: true, createdAt: true } })
      : null;
    if (!cursor) {
      res.status(400).json({ error: "after must be the id of a message in this conversation" });
      return;
    }
    // Ordered by (createdAt, id), so messages sharing a timestamp aren't skipped.
    const messages = await prisma.chatMessage.findMany({
      where: {
        AND: [
          where,
          { OR: [{ createdAt: { gt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { gt: cursor.id } }] },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: CHAT_LIMITS.pageMax,
      select: publicMessage,
    });
    res.json({ buyerId: thread.buyerId, sellerId: thread.sellerId, messages });
    return;
  }

  const latest = await prisma.chatMessage.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CHAT_LIMITS.pageMax,
    select: publicMessage,
  });
  res.json({ buyerId: thread.buyerId, sellerId: thread.sellerId, messages: latest.reverse() });
});

// POST /api/chats/:listingId/read  { messageId, buyerId? }
// Marks the conversation read up to that message (the newest one the client has
// shown), not "now", so a message that arrived after the client's last fetch stays
// unread. The marker only moves forward, so an older tab can't un-read anything.
chatRouter.post("/:listingId/read", async (req, res) => {
  const thread = await resolveThread(req, res, req.body?.buyerId);
  if (!thread) return;

  const messageId = req.body?.messageId;
  const message = isUuid(messageId)
    ? await prisma.chatMessage.findFirst({ where: { ...threadWhere(thread), id: messageId }, select: { createdAt: true } })
    : null;
  if (!message) {
    res.status(404).json({ error: "No such message in this conversation" });
    return;
  }

  const me = req.user!.id;
  await prisma.$executeRaw`
    INSERT INTO chat_reads (user_id, listing_id, buyer_id, last_read_at)
    VALUES (${me}::uuid, ${thread.listingId}::uuid, ${thread.buyerId}::uuid, ${message.createdAt}::timestamptz)
    ON CONFLICT (user_id, listing_id, buyer_id)
    DO UPDATE SET last_read_at = GREATEST(chat_reads.last_read_at, EXCLUDED.last_read_at)`;

  const unread = await findUnreadConversations(me);
  res.json({ unreadCount: unread.length });
});

// POST /api/chats/:listingId/messages  { body, buyerId? }
// A buyer can start a conversation on an ACTIVE listing and keep it going after
// it's reserved or sold (to arrange the handoff). The seller can only reply to
// a buyer who has already written, so sellers can't message arbitrary users.
chatRouter.post("/:listingId/messages", async (req, res) => {
  const thread = await resolveThread(req, res, req.body?.buyerId);
  if (!thread) return;

  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!body || body.length > CHAT_LIMITS.messageMax) {
    res.status(400).json({ error: `Message must be 1-${CHAT_LIMITS.messageMax} characters` });
    return;
  }

  const me = req.user!.id;
  const buyerHasWritten = await prisma.chatMessage.findFirst({
    where: { listingId: thread.listingId, senderId: thread.buyerId, recipientId: thread.sellerId },
    select: { id: true },
  });
  if (me === thread.sellerId && !buyerHasWritten) {
    res.status(404).json({ error: "No conversation with that buyer on this listing" });
    return;
  }
  if (me === thread.buyerId && !buyerHasWritten) {
    const listing = await prisma.listing.findUnique({ where: { id: thread.listingId }, select: { status: true } });
    if (listing?.status !== "ACTIVE") {
      res.status(409).json({ error: "This listing isn't available anymore" });
      return;
    }
  }

  const message = await prisma.chatMessage.create({
    data: {
      listingId: thread.listingId,
      senderId: me,
      recipientId: me === thread.sellerId ? thread.buyerId : thread.sellerId,
      body,
    },
    select: publicMessage,
  });
  res.status(201).json({ message });
});
