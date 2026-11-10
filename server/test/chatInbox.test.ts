import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// Messages inbox: GET /chats (with unread flags), GET /chats/unread-count and
// POST /chats/:listingId/read. Messages are written straight to the DB with
// explicit timestamps, so "newer than the read marker" never depends on timing.

let api: Api;
type Person = { id: string; token: string };
let seller: Person;
let buyer1: Person;
let buyer2: Person;
let stranger: Person;
let listingId: string;
let otherListingId: string;

async function person(label: string): Promise<Person> {
  const user = await createTestUser(label);
  return { id: user.id, token: await login(api, user.email) };
}

const base = Date.now() - 60 * 60 * 1000;
let tick = 0;
/** A message one second after the previous one. */
async function message(listing: string, from: Person, to: Person, body = "hello") {
  tick += 1;
  return prisma.chatMessage.create({
    data: { listingId: listing, senderId: from.id, recipientId: to.id, body, createdAt: new Date(base + tick * 1000) },
    select: { id: true },
  });
}

const unreadCount = async (p: Person) => {
  const res = await api.call("GET", "/chats/unread-count", { token: p.token });
  expect(res.status).toBe(200);
  return res.body.unreadCount as number;
};
const threads = async (p: Person) => {
  const res = await api.call("GET", "/chats", { token: p.token });
  expect(res.status).toBe(200);
  return res.body.threads as { listing: { id: string }; buyerId: string; unread: boolean; otherUser: { id: string } }[];
};
const markRead = (p: Person, listing: string, messageId: string, buyerId?: string) =>
  api.call("POST", `/chats/${listing}/read`, { token: p.token, json: buyerId ? { messageId, buyerId } : { messageId } });

beforeAll(async () => {
  api = await startApi();
  [seller, buyer1, buyer2, stranger] = await Promise.all([person("inbox-seller"), person("inbox-b1"), person("inbox-b2"), person("inbox-x")]);
  const make = () =>
    prisma.listing.create({
      data: { sellerId: seller.id, title: "inbox test", description: "test", category: "OTHER", priceCents: 1000 },
      select: { id: true },
    });
  listingId = (await make()).id;
  otherListingId = (await make()).id;
});

beforeEach(async () => {
  await prisma.chatMessage.deleteMany({ where: { listingId: { in: [listingId, otherListingId] } } });
  await prisma.chatRead.deleteMany({ where: { listingId: { in: [listingId, otherListingId] } } });
});

afterAll(async () => {
  await api.close();
  await cleanup();
  await prisma.$disconnect();
});

describe("messages inbox", () => {
  it("rejects requests without a session", async () => {
    expect((await api.call("GET", "/chats/unread-count")).status).toBe(401);
    expect((await api.call("POST", `/chats/${listingId}/read`, { json: { messageId: randomUUID() } })).status).toBe(401);
  });

  it("only ever lists and counts the user's own conversations", async () => {
    await message(listingId, buyer1, seller, "from b1");
    await message(listingId, buyer2, seller, "from b2");
    await message(listingId, seller, buyer1, "reply to b1");

    const sellerThreads = await threads(seller);
    expect(sellerThreads.map((t) => t.buyerId).sort()).toEqual([buyer1.id, buyer2.id].sort());

    const b1 = await threads(buyer1);
    expect(b1).toHaveLength(1);
    expect(b1[0]).toMatchObject({ buyerId: buyer1.id, otherUser: { id: seller.id } });
    expect((await threads(buyer2)).map((t) => t.buyerId)).toEqual([buyer2.id]);

    expect(await threads(stranger)).toEqual([]);
    expect(await unreadCount(stranger)).toBe(0);
  });

  it("counts conversations with a message from the other person since the last read", async () => {
    await message(listingId, buyer1, seller);
    await message(listingId, buyer1, seller); // same conversation: still one
    await message(listingId, buyer2, seller);
    await message(otherListingId, buyer1, seller);

    expect(await unreadCount(seller)).toBe(3);
    // The buyers only sent; their own messages never make a conversation unread.
    expect(await unreadCount(buyer1)).toBe(0);
    expect(await unreadCount(buyer2)).toBe(0);

    await message(listingId, seller, buyer1);
    expect(await unreadCount(buyer1)).toBe(1);
    expect((await threads(buyer1)).find((t) => t.listing.id === listingId)?.unread).toBe(true);
    expect((await threads(buyer1)).find((t) => t.listing.id === otherListingId)?.unread).toBe(false);
  });

  it("marks a conversation read up to a message, and a newer message makes it unread again", async () => {
    await message(listingId, buyer1, seller);
    const latest = await message(listingId, buyer1, seller);
    await message(listingId, buyer2, seller);
    expect(await unreadCount(seller)).toBe(2);

    const res = await markRead(seller, listingId, latest.id, buyer1.id);
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(await unreadCount(seller)).toBe(1);
    const flags = Object.fromEntries((await threads(seller)).map((t) => [t.buyerId, t.unread]));
    expect(flags).toEqual({ [buyer1.id]: false, [buyer2.id]: true });

    // Reading one person's conversation doesn't touch the other side's state.
    await message(listingId, seller, buyer1);
    expect(await unreadCount(buyer1)).toBe(1);

    await message(listingId, buyer1, seller);
    expect(await unreadCount(seller)).toBe(2);
  });

  it("leaves messages newer than the one marked as unread, and never moves the marker back", async () => {
    const first = await message(listingId, buyer1, seller);
    const second = await message(listingId, buyer1, seller);

    // The client had only seen the first message.
    await markRead(seller, listingId, first.id, buyer1.id);
    expect(await unreadCount(seller)).toBe(1);

    await markRead(seller, listingId, second.id, buyer1.id);
    expect(await unreadCount(seller)).toBe(0);

    // An older tab marking an earlier message doesn't un-read anything.
    expect((await markRead(seller, listingId, first.id, buyer1.id)).status).toBe(200);
    expect(await unreadCount(seller)).toBe(0);
  });

  it("a buyer marks their own conversation read without passing buyerId", async () => {
    await message(listingId, buyer1, seller);
    const reply = await message(listingId, seller, buyer1);
    expect(await unreadCount(buyer1)).toBe(1);
    expect((await markRead(buyer1, listingId, reply.id)).status).toBe(200);
    expect(await unreadCount(buyer1)).toBe(0);
  });

  it("can't mark someone else's conversation read", async () => {
    await message(listingId, buyer1, seller);
    const fromSeller = await message(listingId, seller, buyer1);
    const b2msg = await message(listingId, buyer2, seller);

    // Naming another buyer's conversation.
    expect((await markRead(stranger, listingId, fromSeller.id, buyer1.id)).status).toBe(403);
    expect((await markRead(buyer2, listingId, fromSeller.id, buyer1.id)).status).toBe(403);
    // A message id from someone else's conversation, against your own.
    expect((await markRead(stranger, listingId, fromSeller.id)).status).toBe(404);
    expect((await markRead(buyer2, listingId, fromSeller.id)).status).toBe(404);
    // The seller pointing buyer1's conversation at buyer2's message.
    expect((await markRead(seller, listingId, b2msg.id, buyer1.id)).status).toBe(404);
    expect((await markRead(seller, listingId, "not-a-uuid", buyer1.id)).status).toBe(404);

    expect(await prisma.chatRead.count({ where: { listingId } })).toBe(0);
    expect(await unreadCount(buyer1)).toBe(1);
    expect(await unreadCount(seller)).toBe(2);
  });

  it("drops conversations on removed listings from the list and the count", async () => {
    await message(otherListingId, buyer1, seller);
    expect(await unreadCount(seller)).toBe(1);
    await prisma.listing.update({ where: { id: otherListingId }, data: { status: "REMOVED" } });
    try {
      expect(await unreadCount(seller)).toBe(0);
      expect(await threads(seller)).toEqual([]);
    } finally {
      await prisma.listing.update({ where: { id: otherListingId }, data: { status: "ACTIVE" } });
    }
  });
});
