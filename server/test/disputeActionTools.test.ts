import { randomUUID } from "node:crypto";
import { DISPUTE_APPROVAL_LIMIT_CENTS } from "@campus/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveDisputeDecision,
  DISPUTE_ACTION_TOOLS,
  DISPUTE_RETRY_AFTER_MS,
  executeDisputeDecision,
  maxPartialRefundCents,
  recordDisputeResolution,
  rejectDisputeDecision,
  resolutionEntries,
  resolveEscalatedDispute,
  runDisputeActionTool,
  sweepApprovedDisputeDecisions,
  type ExecutingDecision,
} from "../src/disputes/actionTools.js";
import type { Db } from "../src/db.js";
import { DisputeNotFoundError } from "../src/disputes/readTools.js";
import { expectedTotals } from "../src/jobs/reconciliation.js";
import { postTransaction } from "../src/ledger/postTransaction.js";
import { processPayout } from "../src/payouts/payouts.js";
import { type PayPalClient, PayPalError } from "../src/paypal/client.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// Action tools and the approval gate against the real database with a fake PayPal
// client. No Claude call. ledger_entries is append-only, so tests that commit
// stub postTransaction (cleanup() must delete their orders) and assert on what it
// was given; the real postings are checked in a rolled-back transaction.
//
// The database is shared with real orders, so retry sweeps run "at" 2001, where
// they can't see any real decision.

vi.mock("../src/ledger/postTransaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ledger/postTransaction.js")>();
  return { ...actual, postTransaction: vi.fn(actual.postTransaction) };
});

const paypal = { captureAuthorization: vi.fn(), voidAuthorization: vi.fn(), createPayout: vi.fn() };
const fakePayPal = paypal as unknown as PayPalClient;

const NOW = new Date("2001-01-10T12:00:00.000Z");
const ABOVE_LIMIT = 5000; // the CLAUDE.md example: a $50 sale with a $5 fee
const BELOW_LIMIT = DISPUTE_APPROVAL_LIMIT_CENTS;

const input = { reasoning: "The photos show a cracked screen the listing didn't mention.", evidence: [{ source: "photos", detail: "Photo 1 shows a crack" }] };

let api: Api;
let buyerId: string;
let sellerId: string;
let adminId: string;
let adminToken: string;
let buyerAdminToken: string;
let userToken: string;

beforeAll(async () => {
  api = await startApi({ paypal: () => fakePayPal });
  const buyer = await createTestUser("action-buyer");
  const seller = await createTestUser("action-seller");
  const admin = await createTestUser("action-admin");
  buyerId = buyer.id;
  sellerId = seller.id;
  adminId = admin.id;
  await prisma.user.update({ where: { id: adminId }, data: { isAdmin: true } });
  await prisma.user.update({ where: { id: sellerId }, data: { paypalEmail: "seller@example.com" } });
  adminToken = await login(api, admin.email);
  userToken = await login(api, seller.email);
  // An admin who is also a buyer, for the conflict-of-interest checks.
  const buyerAdmin = await createTestUser("action-buyer-admin");
  await prisma.user.update({ where: { id: buyerAdmin.id }, data: { isAdmin: true } });
  buyerAdminToken = await login(api, buyerAdmin.email);
  buyerAdminId = buyerAdmin.id;
});
let buyerAdminId: string;

afterAll(async () => {
  await api.close();
  await cleanup();
  await prisma.$disconnect();
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(postTransaction).mockResolvedValue({ transactionId: randomUUID(), entryCount: 3 });
  paypal.voidAuthorization.mockResolvedValue({ status: "VOIDED" });
  paypal.captureAuthorization.mockImplementation(async ({ amountCents }: { amountCents: number }) => ({
    captureId: `CAP-${randomUUID()}`,
    status: "COMPLETED",
    amountCents,
    currency: "USD",
  }));
});

async function createDisputedOrder({ amountCents = ABOVE_LIMIT, buyer = buyerId, state = "IN_DISPUTE", status = "OPEN" } = {}) {
  const listing = await prisma.listing.create({
    data: { sellerId, title: "action test", description: "test", category: "OTHER", priceCents: amountCents, status: "RESERVED" },
    select: { id: true },
  });
  const order = await prisma.order.create({
    data: {
      listingId: listing.id,
      buyerId: buyer,
      sellerId,
      state: state as "IN_DISPUTE",
      version: 2,
      amountCents,
      platformFeeCents: Math.floor(amountCents / 10),
      paypalAuthorizationId: `AUTH-${randomUUID()}`,
    },
  });
  await prisma.dispute.create({ data: { orderId: order.id, openedById: buyer, reason: "DAMAGED", description: "Cracked", photoUrls: [], status: status as "OPEN" } });
  return order;
}

const run = (orderId: string, name: string, toolInput: unknown = input) => runDisputeActionTool(fakePayPal, orderId, name, toolInput, { model: "test-model", now: NOW });
const decode = (content: unknown) => JSON.parse(content as string);
const latestDecision = (orderId: string) => prisma.decision.findFirstOrThrow({ where: { orderId }, orderBy: { createdAt: "desc" } });
const readOrder = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });
const readDispute = (orderId: string) => prisma.dispute.findUniqueOrThrow({ where: { orderId } });
const listingStatus = async (id: string) => (await prisma.listing.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

describe("DISPUTE_ACTION_TOOLS", () => {
  it("offers the four actions, none of which can name an order or an approver", () => {
    expect(DISPUTE_ACTION_TOOLS.map((tool) => tool.name)).toEqual(["refund_full", "refund_partial", "release_to_seller", "escalate"]);
    for (const tool of DISPUTE_ACTION_TOOLS) {
      const fields = Object.keys(tool.input_schema.properties);
      for (const banned of ["orderId", "approverId", "approved", "amountCents"]) expect(fields).not.toContain(banned);
      expect(tool.input_schema.additionalProperties).toBe(false);
    }
  });

  it("has no amount on a full refund, so the model can't choose one", () => {
    expect(Object.keys(DISPUTE_ACTION_TOOLS[0].input_schema.properties)).not.toContain("refundCents");
  });
});

describe("the refund cap", () => {
  it("refuses a partial refund above the seller's share, and one above the amount paid, without touching PayPal", async () => {
    const order = await createDisputedOrder();
    for (const refundCents of [maxPartialRefundCents(order) + 1, order.amountCents, order.amountCents + 1, 10_000_000]) {
      const result = await run(order.id, "refund_partial", { ...input, refundCents });
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("at most");
    }
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(await prisma.decision.count({ where: { orderId: order.id } })).toBe(0);
    expect((await readDispute(order.id)).status).toBe("OPEN");
  });

  it.each([0, -100, 12.5, "2000", null])("refuses a refund of %s as invalid input", async (refundCents) => {
    const order = await createDisputedOrder();
    expect(await run(order.id, "refund_partial", { ...input, refundCents })).toEqual({ content: "Invalid tool input", is_error: true });
  });

  it("is backed by a database check", async () => {
    const order = await createDisputedOrder();
    await expect(prisma.order.update({ where: { id: order.id }, data: { refundedCents: order.amountCents + 1 } })).rejects.toThrow();
  });

  it("ignores an amount sent to a full refund", async () => {
    const order = await createDisputedOrder();
    expect((await run(order.id, "refund_full", { ...input, refundCents: 1 })).is_error).toBe(true);
    expect(await prisma.decision.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("tool input", () => {
  it("refuses a decision with no reasoning or evidence, an unknown tool, and an order with no dispute", async () => {
    const order = await createDisputedOrder();
    expect((await run(order.id, "refund_full", { ...input, reasoning: "  " })).is_error).toBe(true);
    expect((await run(order.id, "refund_full", { ...input, evidence: [] })).is_error).toBe(true);
    expect((await run(order.id, "get_money")).is_error).toBe(true);
    expect((await run(order.id, "constructor")).is_error).toBe(true);
    await expect(run(randomUUID(), "refund_full")).rejects.toBeInstanceOf(DisputeNotFoundError);
  });
});

describe("the approval gate", () => {
  it.each([
    ["refund_full", input],
    ["refund_partial", { ...input, refundCents: 100 }], // small refund, but it still sends the rest to the seller
    ["release_to_seller", input],
  ])("holds %s above the limit for an admin, with no PayPal call and no state change", async (name, toolInput) => {
    const order = await createDisputedOrder();
    const result = await run(order.id, name, toolInput);

    expect(decode(result.content).status).toBe("PENDING_APPROVAL");
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).state).toBe("IN_DISPUTE");
    expect((await readDispute(order.id)).status).toBe("PENDING_APPROVAL");
    expect(await latestDecision(order.id)).toMatchObject({ actionStatus: "PENDING_APPROVAL", approverId: null, approvedAt: null });
  });

  it("runs at the limit without an admin, recording that nobody approved it", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    const result = await run(order.id, "refund_full");

    expect(decode(result.content).status).toBe("EXECUTED");
    expect(await latestDecision(order.id)).toMatchObject({ actionStatus: "EXECUTED", approverId: null, approvedAt: NOW });
  });

  it("allows one decision in flight per dispute, including when two race", async () => {
    const order = await createDisputedOrder();
    const results = await Promise.all([run(order.id, "refund_full"), run(order.id, "release_to_seller")]);

    expect(results.filter((r) => !r.is_error)).toHaveLength(1);
    expect(await prisma.decision.count({ where: { orderId: order.id } })).toBe(1);
    expect((await run(order.id, "refund_full")).is_error).toBe(true);
  });

  it("refuses a decision on an order that isn't in dispute", async () => {
    const order = await createDisputedOrder({ state: "CAPTURED" });
    expect((await run(order.id, "refund_full")).is_error).toBe(true);
  });
});

describe("approving and rejecting over the API", () => {
  async function pendingPartialRefund(buyer = buyerId) {
    const order = await createDisputedOrder({ buyer });
    await run(order.id, "refund_partial", { ...input, refundCents: 2000 });
    return { order, decision: await latestDecision(order.id) };
  }

  it("is admins only", async () => {
    const { decision } = await pendingPartialRefund();
    expect((await api.call("POST", `/admin/dispute-decisions/${decision.id}/approve`)).status).toBe(401);
    expect((await api.call("POST", `/admin/dispute-decisions/${decision.id}/approve`, { token: userToken })).status).toBe(403);
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("the demo: an approved partial refund captures the rest, and records the approver, the PayPal id and a matching ledger posting", async () => {
    const { order, decision } = await pendingPartialRefund();
    const res = await api.call("POST", `/admin/dispute-decisions/${decision.id}/approve`, { token: adminToken });

    expect(res.status).toBe(200);
    expect(res.body.decision.actionStatus).toBe("EXECUTED");
    const captureArgs = paypal.captureAuthorization.mock.calls[0][0];
    expect(captureArgs).toMatchObject({ orderId: order.id, authorizationId: order.paypalAuthorizationId, amountCents: 3000 });
    expect(captureArgs.action).toBe(`dispute-${decision.id}-${order.paypalAuthorizationId}`);

    const saved = await latestDecision(order.id);
    expect(saved).toMatchObject({
      outcome: "PARTIAL_REFUND",
      actionStatus: "EXECUTED",
      amountCents: 2000,
      approverId: adminId,
      model: "test-model",
      reasoning: input.reasoning,
      evidence: input.evidence,
    });
    expect(saved.paypalTransactionId).toMatch(/^CAP-/);
    expect(saved.inputs).toMatchObject({ order: { id: order.id, amountCents: 5000 } });
    expect(JSON.stringify(saved.inputs)).not.toContain("Cracked"); // facts only

    expect(await readOrder(order.id)).toMatchObject({ state: "PARTIAL_REFUND", refundedCents: 2000, paypalCaptureId: saved.paypalTransactionId, version: 3 });
    expect(await readDispute(order.id)).toMatchObject({ status: "RESOLVED", resolution: "PARTIAL_REFUND", refundCents: 2000 });
    expect(await listingStatus(order.listingId)).toBe("SOLD");

    const [entries, meta] = vi.mocked(postTransaction).mock.calls[0].slice(1) as [unknown[], object];
    expect(entries).toEqual([
      { account: "escrow_held", amountCents: -5000 },
      { account: "buyer_funds", amountCents: 2000 },
      { account: "seller_payable", amountCents: 2500 },
      { account: "platform_fees", amountCents: 500 },
    ]);
    expect(meta).toMatchObject({ kind: "PARTIAL_REFUND", orderId: order.id, paypalRef: saved.paypalTransactionId });
  });

  it("moves money once when approved twice at the same time", async () => {
    const { decision } = await pendingPartialRefund();
    const url = `/admin/dispute-decisions/${decision.id}/approve`;
    const responses = await Promise.all([api.call("POST", url, { token: adminToken }), api.call("POST", url, { token: adminToken })]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(paypal.captureAuthorization).toHaveBeenCalledTimes(1);
  });

  it("rejecting moves no money, records who rejected it and reopens the dispute", async () => {
    const { order, decision } = await pendingPartialRefund();
    const res = await api.call("POST", `/admin/dispute-decisions/${decision.id}/reject`, { token: adminToken, json: { note: "Photos don't show this" } });

    expect(res.body.decision.actionStatus).toBe("REJECTED");
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(await latestDecision(order.id)).toMatchObject({ approverId: adminId, approvedAt: null, reviewNote: "Photos don't show this" });
    expect((await readDispute(order.id)).status).toBe("OPEN");
    expect((await readOrder(order.id)).state).toBe("IN_DISPUTE");
    expect((await api.call("POST", `/admin/dispute-decisions/${decision.id}/approve`, { token: adminToken })).status).toBe(409);
    expect(decode((await run(order.id, "escalate")).content).status).toBe("EXECUTED");
  });

  it("won't let an admin decide their own order", async () => {
    const { decision } = await pendingPartialRefund(buyerAdminId);
    expect((await api.call("POST", `/admin/dispute-decisions/${decision.id}/approve`, { token: buyerAdminToken })).status).toBe(403);
    expect((await api.call("POST", `/admin/dispute-decisions/${decision.id}/reject`, { token: buyerAdminToken, json: {} })).status).toBe(403);
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
  });

  it("404s on a risk decision or a bad id", async () => {
    const risk = await prisma.decision.create({ data: { kind: "RISK", outcome: "NORMAL", inputs: {} } });
    expect((await api.call("POST", `/admin/dispute-decisions/${risk.id}/approve`, { token: adminToken })).status).toBe(404);
    expect((await api.call("POST", "/admin/dispute-decisions/nope/approve", { token: adminToken })).status).toBe(404);
    await prisma.decision.delete({ where: { id: risk.id } });
  });

  it("shows pending decisions in the dashboard's queue", async () => {
    const { order, decision } = await pendingPartialRefund();
    const { body } = await api.call("GET", "/admin/dashboard", { token: adminToken });
    expect(body.pendingDisputeDecisions.find((d: { id: string }) => d.id === decision.id)).toMatchObject({
      outcome: "PARTIAL_REFUND",
      amountCents: 2000,
      reasoning: input.reasoning,
      order: { id: order.id, amountCents: 5000, listingTitle: "action test" },
    });
  });
});

describe("what each action does", () => {
  it("a full refund voids the hold, takes the listing off sale, and is never paid out", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    await run(order.id, "refund_full");

    expect(paypal.voidAuthorization).toHaveBeenCalledTimes(1);
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(await readOrder(order.id)).toMatchObject({ state: "REFUNDED", refundedCents: BELOW_LIMIT, paypalCaptureId: null });
    expect(await latestDecision(order.id)).toMatchObject({ paypalTransactionId: order.paypalAuthorizationId, amountCents: BELOW_LIMIT });
    expect(await listingStatus(order.listingId)).toBe("REMOVED");
    expect(await readDispute(order.id)).toMatchObject({ status: "RESOLVED", resolution: "REFUNDED", refundCents: BELOW_LIMIT });
    expect(vi.mocked(postTransaction).mock.calls[0][2]).toMatchObject({ kind: "VOID" });
    expect(await processPayout(fakePayPal, order.id, new Date())).toBe("skipped");
  });

  it("a full refund of a hold PayPal already voided still resolves it", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    paypal.voidAuthorization.mockRejectedValue(new PayPalError("void", "http", "gone", { status: 422, issue: "PREVIOUSLY_VOIDED" }));
    expect(decode((await run(order.id, "refund_full")).content).status).toBe("EXECUTED");
    expect((await readOrder(order.id)).state).toBe("REFUNDED");
  });

  it("a release captures the full amount, then pays the seller the normal share", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    await run(order.id, "release_to_seller");

    expect(paypal.captureAuthorization.mock.calls[0][0]).toMatchObject({ amountCents: BELOW_LIMIT });
    const released = await readOrder(order.id);
    expect(released).toMatchObject({ state: "RELEASED", refundedCents: 0 });
    expect(await listingStatus(order.listingId)).toBe("SOLD");

    paypal.createPayout.mockResolvedValue({ payoutBatchId: `B-${randomUUID()}`, batchStatus: "PENDING" });
    expect(await processPayout(fakePayPal, order.id, new Date(released.capturedAt!.getTime() + 1000))).toBe("sent");
    expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amountCents: BELOW_LIMIT - released.platformFeeCents });
    expect((await readOrder(order.id)).state).toBe("PAYOUT_PENDING");
  });

  it("a partial refund pays the seller only what's left after the fee and the refund", async () => {
    const order = await createDisputedOrder({ amountCents: 2000 });
    await run(order.id, "refund_partial", { ...input, refundCents: 500 });
    const refunded = await readOrder(order.id);
    expect(refunded.state).toBe("PARTIAL_REFUND");

    paypal.createPayout.mockResolvedValue({ payoutBatchId: `B-${randomUUID()}`, batchStatus: "PENDING" });
    expect(await processPayout(fakePayPal, order.id, new Date(refunded.capturedAt!.getTime() + 1000))).toBe("sent");
    expect(paypal.createPayout.mock.calls[0][0]).toMatchObject({ amountCents: 2000 - 200 - 500 });
  });

  it("escalating moves no money, needs no approval at any amount, and locks the agent out", async () => {
    const order = await createDisputedOrder();
    expect(decode((await run(order.id, "escalate")).content).status).toBe("EXECUTED");

    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
    expect(postTransaction).not.toHaveBeenCalled();
    expect((await readOrder(order.id)).state).toBe("ESCALATED");
    expect(await listingStatus(order.listingId)).toBe("RESERVED");
    expect(await readDispute(order.id)).toMatchObject({ status: "ESCALATED", resolution: "ESCALATED", resolvedAt: null });
    expect((await run(order.id, "refund_full")).is_error).toBe(true);
  });

  it("an admin can then decide the escalated dispute, recorded as its approver", async () => {
    const order = await createDisputedOrder();
    await run(order.id, "escalate");
    const res = await api.call("POST", `/admin/disputes/${order.id}/resolve`, { token: adminToken, json: { action: "PARTIAL_REFUND", refundCents: 1000, reasoning: "Spoke to both" } });

    expect(res.body.decision.actionStatus).toBe("EXECUTED");
    expect((await readOrder(order.id)).state).toBe("PARTIAL_REFUND");
    expect(await latestDecision(order.id)).toMatchObject({ approverId: adminId, reasoning: "Spoke to both", model: null });
    expect((await readDispute(order.id)).status).toBe("RESOLVED");
  });

  it("an admin's decision has the same cap, and only applies to escalated disputes", async () => {
    const order = await createDisputedOrder();
    const open = await api.call("POST", `/admin/disputes/${order.id}/resolve`, { token: adminToken, json: { action: "REFUND", reasoning: "x" } });
    expect(open.status).toBe(409);

    await run(order.id, "escalate");
    const tooMuch = await api.call("POST", `/admin/disputes/${order.id}/resolve`, { token: adminToken, json: { action: "PARTIAL_REFUND", refundCents: 5000, reasoning: "x" } });
    expect(tooMuch.status).toBe(422);
    const noReason = await api.call("POST", `/admin/disputes/${order.id}/resolve`, { token: adminToken, json: { action: "REFUND" } });
    expect(noReason.status).toBe(400);
    expect((await api.call("POST", `/admin/disputes/${order.id}/resolve`, { token: userToken, json: { action: "REFUND", reasoning: "x" } })).status).toBe(403);
    expect((await api.call("POST", `/admin/disputes/${randomUUID()}/resolve`, { token: adminToken, json: { action: "REFUND", reasoning: "x" } })).status).toBe(404);
  });
});

describe("when PayPal or the order misbehaves", () => {
  it("a timeout leaves it APPROVED, and the sweep re-sends with the same request id", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    paypal.captureAuthorization.mockRejectedValueOnce(new PayPalError("capture", "timeout", "no response"));

    expect(decode((await run(order.id, "release_to_seller")).content).status).toBe("APPROVED");
    expect((await readOrder(order.id)).state).toBe("IN_DISPUTE");
    expect((await readDispute(order.id)).status).toBe("PENDING_APPROVAL");
    expect((await latestDecision(order.id)).actionError).toContain("no response");

    const tooSoon = await sweepApprovedDisputeDecisions(fakePayPal, { now: new Date(NOW.getTime() + 1000) });
    expect(tooSoon.checked).toBe(0);

    const result = await sweepApprovedDisputeDecisions(fakePayPal, { now: new Date(NOW.getTime() + DISPUTE_RETRY_AFTER_MS) });
    expect(result).toMatchObject({ checked: 1, executed: 1 });
    const [first, second] = paypal.captureAuthorization.mock.calls;
    expect(second[0].action).toBe(first[0].action);
    expect((await readOrder(order.id)).state).toBe("RELEASED");
    expect((await latestDecision(order.id)).actionError).toBeNull();
  });

  it("a refusal fails the decision, moves nothing and reopens the dispute", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    paypal.captureAuthorization.mockRejectedValueOnce(new PayPalError("capture", "http", "refused", { status: 422, issue: "AUTHORIZATION_EXPIRED" }));

    const result = await run(order.id, "release_to_seller");
    expect(decode(result.content).status).toBe("FAILED");
    expect((await latestDecision(order.id)).actionStatus).toBe("FAILED");
    expect(postTransaction).not.toHaveBeenCalled();
    expect((await readDispute(order.id)).status).toBe("OPEN");
    expect(decode((await run(order.id, "refund_full")).content).status).toBe("EXECUTED");
  });

  it("a void refused because the money was captured stays locked for a person", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    paypal.voidAuthorization.mockRejectedValueOnce(new PayPalError("void", "http", "captured", { status: 422, issue: "PREVIOUSLY_CAPTURED" }));

    await run(order.id, "refund_full");
    expect((await latestDecision(order.id)).actionStatus).toBe("FAILED");
    expect((await readDispute(order.id)).status).toBe("PENDING_APPROVAL");
    expect((await readOrder(order.id)).state).toBe("IN_DISPUTE");
  });

  it("a capture for the wrong amount records no state change, keeps the PayPal id and stays locked", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    paypal.captureAuthorization.mockResolvedValueOnce({ captureId: "CAP-WRONG", status: "COMPLETED", amountCents: 1, currency: "USD" });

    await run(order.id, "release_to_seller");
    expect(await latestDecision(order.id)).toMatchObject({ actionStatus: "FAILED", paypalTransactionId: "CAP-WRONG" });
    expect((await readOrder(order.id)).state).toBe("IN_DISPUTE");
    expect(postTransaction).not.toHaveBeenCalled();
  });

  it("does nothing at PayPal if the order moved on before approval", async () => {
    const order = await createDisputedOrder();
    await run(order.id, "refund_full");
    await prisma.order.update({ where: { id: order.id }, data: { state: "REFUNDED", version: { increment: 1 } } });
    const decision = await latestDecision(order.id);

    const result = await approveDisputeDecision(fakePayPal, decision.id, adminId, NOW);
    expect(result.actionStatus).toBe("FAILED");
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
  });

  it("if the order moves while PayPal is answering, the decision fails and stays locked", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    paypal.captureAuthorization.mockImplementationOnce(async ({ amountCents }: { amountCents: number }) => {
      await prisma.order.update({ where: { id: order.id }, data: { version: { increment: 1 } } });
      return { captureId: "CAP-RACE", status: "COMPLETED", amountCents, currency: "USD" };
    });

    await run(order.id, "release_to_seller");
    expect(await latestDecision(order.id)).toMatchObject({ actionStatus: "FAILED", paypalTransactionId: "CAP-RACE" });
    expect((await readDispute(order.id)).status).toBe("PENDING_APPROVAL");
  });

  it("executing a finished decision again changes nothing", async () => {
    const order = await createDisputedOrder({ amountCents: BELOW_LIMIT });
    await run(order.id, "release_to_seller");
    const { id } = await latestDecision(order.id);
    expect((await executeDisputeDecision(fakePayPal, id, NOW)).actionStatus).toBe("EXECUTED");
    expect(paypal.captureAuthorization).toHaveBeenCalledTimes(1);
  });

  it("rejectDisputeDecision and resolveEscalatedDispute refuse bad ids", async () => {
    await expect(rejectDisputeDecision("nope", adminId, null)).rejects.toMatchObject({ status: 404 });
    await expect(resolveEscalatedDispute(fakePayPal, "nope", { action: "REFUND", reasoning: "x" }, adminId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("ledger postings", () => {
  const order = (over = {}) => ({ id: randomUUID(), listingId: randomUUID(), state: "IN_DISPUTE" as const, version: 2, amountCents: 5000, platformFeeCents: 500, currency: "USD", paypalAuthorizationId: "AUTH", ...over });
  const sum = (entries: { amountCents: number }[]) => entries.reduce((n, e) => n + e.amountCents, 0);

  it.each([
    ["REFUND", 5000],
    ["PARTIAL_REFUND", 2000],
    ["PARTIAL_REFUND", 4499],
    ["RELEASE", null],
  ] as const)("%s (%s) balances to zero and empties escrow", (outcome, amountCents) => {
    const entries = resolutionEntries({ outcome, amountCents, order: order() });
    expect(sum(entries)).toBe(0);
    expect(entries.find((e) => e.account === "escrow_held")?.amountCents).toBe(-5000);
    expect(entries.every((e) => e.amountCents !== 0)).toBe(true);
  });

  it("leaves out the fee entry on a sale with no fee", () => {
    const entries = resolutionEntries({ outcome: "RELEASE", amountCents: null, order: order({ amountCents: 5, platformFeeCents: 0 }) });
    expect(entries.map((e) => e.account)).toEqual(["escrow_held", "seller_payable"]);
  });

  it("agrees with what reconciliation expects from PayPal after a partial refund", () => {
    const entries = resolutionEntries({ outcome: "PARTIAL_REFUND", amountCents: 2000, order: order() });
    const balance = (account: string) => entries.find((e) => e.account === account)?.amountCents ?? 0;
    const paypalView = expectedTotals(
      { amountCents: 5000 },
      {
        authorization: { id: "A", status: "PARTIALLY_CAPTURED", amountCents: 5000, currency: "USD" },
        capture: { id: "C", status: "COMPLETED", amountCents: 3000, currency: "USD" },
        refunds: [],
        payoutItem: null,
      },
    );
    expect(paypalView.held).toBe(0); // the authorize posting's +5000 is cancelled by this −5000
    expect(balance("seller_payable") + balance("platform_fees")).toBe(paypalView.captured);
  });

  it("posts for real in one transaction, passing the database's balance check", async () => {
    class Rollback extends Error {}
    vi.mocked(postTransaction).mockImplementation((await vi.importActual<typeof import("../src/ledger/postTransaction.js")>("../src/ledger/postTransaction.js")).postTransaction);
    const created = await createDisputedOrder();
    const dispute = await readDispute(created.id);
    const decision = await prisma.decision.create({
      data: { kind: "DISPUTE", outcome: "PARTIAL_REFUND", amountCents: 2000, orderId: created.id, disputeId: dispute.id, inputs: {}, actionStatus: "APPROVED", approvedAt: NOW },
    });
    const executing: ExecutingDecision = {
      id: decision.id,
      disputeId: dispute.id,
      outcome: "PARTIAL_REFUND",
      amountCents: 2000,
      order: { ...created, paypalAuthorizationId: created.paypalAuthorizationId },
    };

    await expect(
      prisma.$transaction(async (tx: Db) => {
        await recordDisputeResolution(tx, executing, "CAP-REAL", NOW);
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`; // the ledger's commit-time balance check
        const rows = await tx.ledgerEntry.findMany({ where: { orderId: created.id } });
        expect(sum(rows)).toBe(0);
        expect(rows.every((r) => r.paypalRef === "CAP-REAL" && r.kind === "PARTIAL_REFUND")).toBe(true);
        expect(await tx.outboxEvent.count({ where: { orderId: created.id, topic: "order.state_changed" } })).toBe(1);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
    expect((await readOrder(created.id)).state).toBe("IN_DISPUTE");
  });
});
