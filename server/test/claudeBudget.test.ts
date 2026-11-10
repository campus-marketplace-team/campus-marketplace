import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callClaude,
  CLAUDE_BUDGET_MAX,
  CLAUDE_CALL_CAPS,
  claudeBudgetLimits,
  ClaudeBudgetExceededError,
  ClaudeBudgetUnavailableError,
  ClaudeInputTooLargeError,
  getClaudeUsage,
  reserveClaudeCall,
} from "../src/ai/claude.js";
import { callDisputeAgentClaude } from "../src/disputes/agentClaude.js";
import type { PayPalClient } from "../src/paypal/client.js";
import { capRiskInput, classifyRisk, encodeForPrompt, MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_MESSAGES, MAX_CHAT_TOTAL_CHARS, type RiskInput } from "../src/risk/classifier.js";
import { type Api, cleanup, createTestUser, login, prisma, startApi } from "./helpers/api.js";

// The budget against the real table with a fake Claude. The database is shared with
// production, so every test runs "on" its own day long past: it can't touch today's
// real counts, and afterAll deletes those rows.

const usedDays: Date[] = [];
const yearBase = 1980 + Math.floor(Math.random() * 15);
function pastDay() {
  const day = new Date(Date.UTC(yearBase, 0, 1 + usedDays.length, 12));
  usedDays.push(new Date(day.toISOString().slice(0, 10)));
  return day;
}

const callsOn = async (now: Date, scope: string) =>
  (await prisma.claudeBudgetUsage.findUnique({ where: { day_scope: { day: new Date(now.toISOString().slice(0, 10)), scope } } }))?.calls ?? null;

const OK_ANSWER = { model: "fake", stop_reason: "end_turn", stop_details: null, content: [{ type: "text", text: JSON.stringify({ risk: "low", reasons: ["fine"], signals: [] }) }] } as never;
const SEND_OPTIONS = { timeout: 1000, maxRetries: 0 };
const PARAMS = { model: "fake", messages: [{ role: "user" as const, content: "hello" }] };

const INPUT: RiskInput = {
  listing: { title: "Lamp", description: "Works.", category: "OTHER", priceCents: 1000, currency: "USD" },
  features: {
    sellerAccountAgeDays: 100,
    sellerListingsLast24h: 1,
    price: { amountCents: 1000, categoryMedianCents: null, ratioToMedian: null, comparableListings: 0 },
    sellerPastDisputes: 0,
    buyerPastDisputes: 0,
    offPlatformPhrases: [],
    injectionPhrases: [],
  },
  chat: [],
  omittedChatMessages: 0,
};

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  userId = (await createTestUser("budget-a")).id;
  otherUserId = (await createTestUser("budget-b")).id;
});

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.claudeBudgetUsage.deleteMany({ where: { day: { in: usedDays } } });
  await cleanup();
  await prisma.$disconnect();
});

describe("claudeBudgetLimits", () => {
  it("uses the hard-coded maximums by default", () => {
    expect(CLAUDE_BUDGET_MAX).toEqual({ callsPerDay: 300, callsPerUserPerDay: 20 });
    expect(claudeBudgetLimits({}, {})).toEqual({ callsPerDay: 300, callsPerUserPerDay: 20 });
  });

  it("lets env vars lower the limits, but never raise them", () => {
    expect(claudeBudgetLimits({}, { CLAUDE_BUDGET_CALLS_PER_DAY: "50", CLAUDE_BUDGET_CALLS_PER_USER_PER_DAY: "5" })).toEqual({ callsPerDay: 50, callsPerUserPerDay: 5 });
    expect(claudeBudgetLimits({}, { CLAUDE_BUDGET_CALLS_PER_DAY: "100000", CLAUDE_BUDGET_CALLS_PER_USER_PER_DAY: "100000" })).toEqual(CLAUDE_BUDGET_MAX);
    expect(claudeBudgetLimits({}, { CLAUDE_BUDGET_CALLS_PER_DAY: "0" }).callsPerDay).toBe(0);
  });

  it.each(["", "abc", "-5", "1.5", "1e9", "Infinity"])("ignores the invalid env value %j", (value) => {
    expect(claudeBudgetLimits({}, { CLAUDE_BUDGET_CALLS_PER_DAY: value }).callsPerDay).toBe(300);
  });

  it("doesn't let injected limits raise them either, or escape a lower env var", () => {
    expect(claudeBudgetLimits({ callsPerDay: 5000, callsPerUserPerDay: 5000 }, {})).toEqual(CLAUDE_BUDGET_MAX);
    expect(claudeBudgetLimits({ callsPerDay: 2 }, {}).callsPerDay).toBe(2);
    expect(claudeBudgetLimits({ callsPerDay: 200 }, { CLAUDE_BUDGET_CALLS_PER_DAY: "50" }).callsPerDay).toBe(50);
  });
});

describe("reserveClaudeCall", () => {
  it("never lets concurrent requests pass the daily limit", async () => {
    const now = pastDay();
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveClaudeCall({ userId: null, limits: { callsPerDay: 3 }, now })));
    expect(results.filter((r) => r === null)).toHaveLength(3);
    expect(results.filter((r) => r === "day")).toHaveLength(9);
    expect(await callsOn(now, "total")).toBe(3);
  });

  it("never lets one user's concurrent requests pass their limit", async () => {
    const now = pastDay();
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveClaudeCall({ userId, limits: { callsPerUserPerDay: 2 }, now })));
    expect(results.filter((r) => r === null)).toHaveLength(2);
    expect(results.filter((r) => r === "user")).toHaveLength(8);
    expect(await callsOn(now, `user:${userId}`)).toBe(2);
    expect(await callsOn(now, "total")).toBe(2);
  });

  it("takes from neither count when the day is used up", async () => {
    const now = pastDay();
    const limits = { callsPerDay: 1, callsPerUserPerDay: 5 };
    expect(await reserveClaudeCall({ userId: otherUserId, limits, now })).toBeNull();
    expect(await reserveClaudeCall({ userId, limits, now })).toBe("day");
    expect(await callsOn(now, `user:${userId}`)).toBeNull();
    expect(await callsOn(now, "total")).toBe(1);
  });

  it("takes from neither count when the user is used up", async () => {
    const now = pastDay();
    const limits = { callsPerDay: 5, callsPerUserPerDay: 1 };
    expect(await reserveClaudeCall({ userId, limits, now })).toBeNull();
    expect(await reserveClaudeCall({ userId, limits, now })).toBe("user");
    expect(await callsOn(now, "total")).toBe(1);
  });

  it("keeps each user's count separate, and starts again the next UTC day", async () => {
    const now = pastDay();
    const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    usedDays.push(new Date(nextDay.toISOString().slice(0, 10)));
    pastDay(); // keeps later tests off nextDay
    const limits = { callsPerUserPerDay: 1 };
    expect(await reserveClaudeCall({ userId, limits, now })).toBeNull();
    expect(await reserveClaudeCall({ userId: otherUserId, limits, now })).toBeNull();
    expect(await reserveClaudeCall({ userId, limits, now: nextDay })).toBeNull();
  });

  it("refuses at a limit of zero without writing anything", async () => {
    const now = pastDay();
    expect(await reserveClaudeCall({ userId: null, limits: { callsPerDay: 0 }, now })).toBe("day");
    expect(await reserveClaudeCall({ userId, limits: { callsPerUserPerDay: 0 }, now })).toBe("user");
    expect(await callsOn(now, "total")).toBeNull();
  });
});

describe("callClaude", () => {
  it("reserves first, then sends with the call site's max_tokens", async () => {
    const now = pastDay();
    const createMessage = vi.fn().mockImplementation(async () => {
      expect(await callsOn(now, "total")).toBe(1);
      return OK_ANSWER;
    });
    await callClaude("risk_classifier", { userId, now }, PARAMS, SEND_OPTIONS, createMessage);
    expect(createMessage.mock.calls[0][0].max_tokens).toBe(CLAUDE_CALL_CAPS.risk_classifier.maxTokens);
  });

  it("doesn't send when the budget is used up", async () => {
    const createMessage = vi.fn();
    await expect(callClaude("risk_classifier", { userId, limits: { callsPerDay: 0 } }, PARAMS, SEND_OPTIONS, createMessage)).rejects.toBeInstanceOf(ClaudeBudgetExceededError);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("doesn't send if the reservation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database down"));
    const createMessage = vi.fn();
    await expect(callClaude("risk_classifier", { userId }, PARAMS, SEND_OPTIONS, createMessage)).rejects.toBeInstanceOf(ClaudeBudgetUnavailableError);
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("refuses input over the call site's cap before spending any budget", async () => {
    const now = pastDay();
    const createMessage = vi.fn();
    const big = { ...PARAMS, messages: [{ role: "user" as const, content: "x".repeat(CLAUDE_CALL_CAPS.risk_classifier.maxInputChars + 1) }] };
    await expect(callClaude("risk_classifier", { userId, now }, big, SEND_OPTIONS, createMessage)).rejects.toBeInstanceOf(ClaudeInputTooLargeError);
    expect(createMessage).not.toHaveBeenCalled();
    expect(await callsOn(now, "total")).toBeNull();
  });

  it("only skips the budget with the explicit bypass, and writes nothing", async () => {
    const spy = vi.spyOn(prisma, "$transaction");
    const createMessage = vi.fn().mockResolvedValue(OK_ANSWER);
    await callClaude("risk_classifier", { bypass: "eval" }, PARAMS, SEND_OPTIONS, createMessage);
    expect(createMessage).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("getClaudeUsage", () => {
  it("reports the day's calls against the limits", async () => {
    const now = pastDay();
    const limits = { callsPerDay: 10, callsPerUserPerDay: 2 };
    await reserveClaudeCall({ userId, limits, now });
    await reserveClaudeCall({ userId, limits, now });
    await reserveClaudeCall({ userId: otherUserId, limits, now });
    await reserveClaudeCall({ userId: null, limits, now });

    expect(await getClaudeUsage(now, limits)).toEqual({
      day: now.toISOString().slice(0, 10),
      calls: 4,
      limit: 10,
      perUserLimit: 2,
      usersAtLimit: 1,
      busiestUserCalls: 2,
    });
  });

  it("reports zero on a day with no calls", async () => {
    expect(await getClaudeUsage(pastDay())).toMatchObject({ calls: 0, limit: 300, perUserLimit: 20, usersAtLimit: 0, busiestUserCalls: 0 });
  });
});

describe("risk classifier with the budget", () => {
  it("falls back to medium with cause budget_exceeded, without calling Claude", async () => {
    const createMessage = vi.fn();
    const result = await classifyRisk(INPUT, { budget: { userId, limits: { callsPerUserPerDay: 0 } }, createMessage });
    expect(result).toMatchObject({ risk: "medium", source: "fallback", fallbackReason: "budget_exceeded", rawOutput: null });
    expect(createMessage).not.toHaveBeenCalled();
  });

  it("falls back to medium if the budget can't be checked", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("database down"));
    const result = await classifyRisk(INPUT, { budget: { userId }, createMessage: vi.fn() });
    expect(result).toMatchObject({ risk: "medium", source: "fallback", fallbackReason: "budget_unavailable" });
  });

  it("answers normally within the budget, and counts the call", async () => {
    const now = pastDay();
    const result = await classifyRisk(INPUT, { budget: { userId, now }, createMessage: vi.fn().mockResolvedValue(OK_ANSWER) });
    expect(result).toMatchObject({ risk: "low", source: "llm" });
    expect(await callsOn(now, `user:${userId}`)).toBe(1);
  });

  it("stays within its input cap on the largest input the caps allow", async () => {
    const attack = "<".repeat(5000);
    const createMessage = vi.fn().mockResolvedValue(OK_ANSWER);
    const input: RiskInput = {
      ...INPUT,
      listing: { ...INPUT.listing, title: "<".repeat(100), description: "<".repeat(2000) },
      features: { ...INPUT.features, offPlatformPhrases: Array.from({ length: 500 }, () => ({ phrase: "e_transfer", messageId: randomUUID(), sender: "seller" as const })) },
      chat: Array.from({ length: 200 }, () => ({ id: randomUUID(), sender: "seller" as const, body: attack })),
    };
    const result = await classifyRisk(input, { budget: { bypass: "live_check" }, createMessage });
    expect(result.source).toBe("llm");
    expect(createMessage).toHaveBeenCalledTimes(1);
  });
});

describe("capRiskInput", () => {
  const message = (body: string, id = randomUUID()) => ({ id, sender: "buyer" as const, body });

  it("leaves ordinary input alone", () => {
    const input = { ...INPUT, chat: [message("hello"), message("hi")] };
    expect(capRiskInput(input)).toEqual(input);
  });

  it("cuts long messages and marks them", () => {
    const [capped] = capRiskInput({ ...INPUT, chat: [message("x".repeat(1500))] }).chat;
    expect(capped.body).toHaveLength(MAX_CHAT_MESSAGE_CHARS);
    expect(capped.body.endsWith("[truncated]")).toBe(true);
  });

  it("keeps only the newest messages that fit, and reports how many it left out", () => {
    const chat = Array.from({ length: 20 }, (_, i) => message(`${i} `.padEnd(1000, "x")));
    const capped = capRiskInput({ ...INPUT, chat, omittedChatMessages: 3 });
    expect(capped.chat.at(-1)).toEqual(chat.at(-1));
    expect(capped.chat.length).toBeLessThan(20);
    expect(capped.omittedChatMessages).toBe(3 + 20 - capped.chat.length);
    expect(capped.chat.reduce((n, m) => n + encodeForPrompt(m.body).length, 0)).toBeLessThanOrEqual(MAX_CHAT_TOTAL_CHARS);
  });

  it("keeps at most MAX_CHAT_MESSAGES", () => {
    const capped = capRiskInput({ ...INPUT, chat: Array.from({ length: MAX_CHAT_MESSAGES + 10 }, () => message("hi")) });
    expect(capped.chat).toHaveLength(MAX_CHAT_MESSAGES);
    expect(capped.omittedChatMessages).toBe(10);
  });

  it("changes nothing the second time", () => {
    const once = capRiskInput({ ...INPUT, chat: Array.from({ length: 30 }, () => message("<".repeat(1500))) });
    expect(capRiskInput(once)).toEqual(once);
  });
});

describe("checkout with the budget used up", () => {
  const paypal = { createOrder: vi.fn() };
  let api: Api;
  let token: string;
  let sellerId: string;

  beforeAll(async () => {
    api = await startApi({
      paypal: () => paypal as unknown as PayPalClient,
      // The real classifier and budget, at a limit that's already used up.
      classify: (input, budget) => classifyRisk(input, { budget: { ...budget, limits: { callsPerDay: 0 } }, createMessage: vi.fn() }),
    });
    const buyer = await createTestUser("budget-buyer");
    token = await login(api, buyer.email);
    sellerId = (await createTestUser("budget-seller")).id;
  });

  afterAll(() => api.close());

  it("still works, with the longer hold and a warning", async () => {
    paypal.createOrder.mockResolvedValue({ paypalOrderId: `PPBUDGET-${randomUUID()}`, status: "CREATED", approveUrl: null });
    const listing = await prisma.listing.create({
      data: { sellerId, title: "budget test", description: "test", category: "OTHER", priceCents: 2000, createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      select: { id: true },
    });

    const check = await api.call("POST", "/orders/assess", { token, json: { listingId: listing.id } });
    expect(check.body).toEqual({ outcome: "HOLD_WITH_WARNING", reasons: [] });
    const res = await api.call("POST", "/orders", { token, json: { listingId: listing.id } });

    expect(res.status).toBe(201);
    expect(res.body.riskWarning).toBe(true);
    const decision = await prisma.decision.findFirstOrThrow({ where: { orderId: res.body.orderId, kind: "RISK" } });
    expect(decision).toMatchObject({ risk: "medium", outcome: "HOLD_WITH_WARNING" });
    expect(decision.llmOutput).toMatchObject({ source: "fallback", fallbackReason: "budget_exceeded" });
  });
});

describe("dispute agent with the budget", () => {
  const paypal = { voidAuthorization: vi.fn(), captureAuthorization: vi.fn() };
  const fakePayPal = paypal as unknown as PayPalClient;

  async function disputedOrder() {
    const buyerId = (await createTestUser("budget-dispute-buyer")).id;
    const sellerId = (await createTestUser("budget-dispute-seller")).id;
    const listing = await prisma.listing.create({ data: { sellerId, title: "dispute budget", description: "test", category: "OTHER", priceCents: 5000 }, select: { id: true } });
    const order = await prisma.order.create({
      data: { listingId: listing.id, buyerId, sellerId, amountCents: 5000, platformFeeCents: 500, currency: "USD", state: "IN_DISPUTE" },
      select: { id: true },
    });
    await prisma.dispute.create({ data: { orderId: order.id, openedById: buyerId, reason: "OTHER", description: "broken", photoUrls: [] } });
    return { orderId: order.id, buyerId };
  }

  it("leaves the dispute for an admin when the budget is used up, moving no money", async () => {
    const { orderId, buyerId } = await disputedOrder();
    const createMessage = vi.fn();

    const result = await callDisputeAgentClaude(fakePayPal, orderId, { userId: buyerId, limits: { callsPerDay: 0 } }, PARAMS, SEND_OPTIONS, createMessage);

    expect(result).toEqual({ status: "left_for_admin" });
    expect(createMessage).not.toHaveBeenCalled();
    expect(paypal.voidAuthorization).not.toHaveBeenCalled();
    expect(paypal.captureAuthorization).not.toHaveBeenCalled();
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true } })).toEqual({ state: "ESCALATED" });
    expect(await prisma.dispute.findUniqueOrThrow({ where: { orderId }, select: { status: true } })).toEqual({ status: "ESCALATED" });
    const decision = await prisma.decision.findFirstOrThrow({ where: { orderId, kind: "DISPUTE" } });
    expect(decision).toMatchObject({ outcome: "ESCALATE", llmOutput: null, model: null });
  });

  it("leaves a dispute alone if a decision already got there first", async () => {
    const { orderId, buyerId } = await disputedOrder();
    const budget = { userId: buyerId, limits: { callsPerDay: 0 } };
    await callDisputeAgentClaude(fakePayPal, orderId, budget, PARAMS, SEND_OPTIONS, vi.fn());
    await expect(callDisputeAgentClaude(fakePayPal, orderId, budget, PARAMS, SEND_OPTIONS, vi.fn())).resolves.toEqual({ status: "left_for_admin" });
    expect(await prisma.decision.count({ where: { orderId, kind: "DISPUTE" } })).toBe(1);
  });

  it("passes the answer back within the budget, using its own max_tokens", async () => {
    const { orderId, buyerId } = await disputedOrder();
    const now = pastDay();
    const createMessage = vi.fn().mockResolvedValue(OK_ANSWER);

    const result = await callDisputeAgentClaude(fakePayPal, orderId, { userId: buyerId, now }, PARAMS, SEND_OPTIONS, createMessage);

    expect(result).toEqual({ status: "answered", response: OK_ANSWER });
    expect(createMessage.mock.calls[0][0].max_tokens).toBe(CLAUDE_CALL_CAPS.dispute_agent.maxTokens);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true } })).toEqual({ state: "IN_DISPUTE" });
  });

  it("doesn't escalate on an ordinary API error", async () => {
    const { orderId, buyerId } = await disputedOrder();
    const createMessage = vi.fn().mockRejectedValue(new Error("connection reset"));
    await expect(callDisputeAgentClaude(fakePayPal, orderId, { userId: buyerId, now: pastDay() }, PARAMS, SEND_OPTIONS, createMessage)).rejects.toThrow("connection reset");
    expect(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { state: true } })).toEqual({ state: "IN_DISPUTE" });
  });
});
